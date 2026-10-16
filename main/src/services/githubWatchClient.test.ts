import { describe, expect, it, vi } from 'vitest';
import { GithubWatchClient, GithubWatchError } from './githubWatchClient';

const target = (number: number) => ({ host: 'github.com', owner: 'acme', repo: 'app', number });
function detailPage(head = 'a', next = false) {
  return { data: { viewer: { login: 'me' }, repository: { pullRequest: {
    number: 1, url: 'https://github.com/acme/app/pull/1', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head,
    comments: { nodes: [{ id: 'own', updatedAt: 'today', author: { login: 'me' } }, { id: 'external', updatedAt: 'today', author: null }] },
    reviews: { nodes: [{ id: 'review', submittedAt: 'today', lastEditedAt: null, state: 'APPROVED', author: { login: 'peer' } }] },
    reviewThreads: { nodes: [{ comments: { nodes: [{ id: 'thread', updatedAt: 'today', author: { login: 'peer' } }] } }] },
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: {
      pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null },
      nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true }],
    } } } }] },
  } } } };
}

describe('complete PR reads', () => {
  it('paginates required checks and excludes the authenticated account from discussion updates', async () => {
    const bodies: string[] = [];
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: async (_url, init) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(detailPage('a', bodies.length === 1)));
    } });
    const detail = await client.details(target(1));
    expect(detail.checks).toHaveLength(2);
    expect(detail.checks.every(check => check.isRequired)).toBe(true);
    expect(detail.complete).toBe(true);
    expect(bodies[1]).toContain('after:');
    expect(detail.comments).toEqual(['external:today', 'thread:today']);
    expect(detail.reviews).toEqual(['review:today:null:APPROVED']);
  });

  it('rejects a head change between check pages', async () => {
    let reads = 0;
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: async () => {
      reads++;
      return new Response(JSON.stringify(detailPage(reads === 1 ? 'a' : 'b', reads === 1)));
    } });
    await expect(client.details(target(1))).rejects.toThrow('head changed');
  });

  it('keeps a missing rollup empty and caps pathological check pagination', async () => {
    const empty = detailPage();
    const pr = empty.data.repository.pullRequest;
    const data = { ...empty.data, repository: { pullRequest: { ...pr, commits: { nodes: [{ commit: { oid: 'a', statusCheckRollup: null } }] } } } };
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: async () => new Response(JSON.stringify({ data })) });
    expect(await client.details(target(1))).toMatchObject({ checks: [], complete: true });
    const fetcher = vi.fn(async () => new Response(JSON.stringify(detailPage('a', true))));
    const bounded = new GithubWatchClient({ token: async () => 'secret', fetch: fetcher });
    expect(await bounded.details(target(1))).toMatchObject({ complete: false });
    expect(fetcher).toHaveBeenCalledTimes(20);
  });
});

describe('GitHub watch transport', () => {
  it('reads 51 fingerprints in three bounded requests, sharing one credential', async () => {
    const token = vi.fn(async () => 'secret');
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      const data = Object.fromEntries([...String(init.body).matchAll(/p(\d+): repository/g)].map(m => [`p${m[1]}`, { pullRequest: { state: 'OPEN' } }]));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const client = new GithubWatchClient({ token, fetch: fetcher });
    const result = await client.fingerprints(Array.from({ length: 51 }, (_, i) => target(i + 1)));
    expect(result.size).toBe(51);
    expect(bodies.map(body => [...body.matchAll(/: repository/g)].length)).toEqual([25, 25, 1]);
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After without spending more requests', async () => {
    let now = 1000;
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: fetcher, now: () => now });
    await expect(client.fingerprints([target(1)])).rejects.toMatchObject({ rateLimited: true, retryAt: 61000 });
    now = 2000;
    await expect(client.fingerprints([target(1)])).rejects.toBeInstanceOf(GithubWatchError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('GitHub recovery policy', () => {
  it('refreshes a rejected credential once, without leaking either credential', async () => {
    const token = vi.fn().mockResolvedValueOnce('old-secret').mockResolvedValueOnce('new-secret');
    const headers: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get('authorization') ?? '');
      return headers.length === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ data: { p0: { pullRequest: { state: 'OPEN' } } } }));
    });
    const client = new GithubWatchClient({ token, fetch: fetcher });
    expect((await client.fingerprints([target(1)])).size).toBe(1);
    expect(headers).toEqual(['Bearer old-secret', 'Bearer new-secret']);
    expect(token).toHaveBeenCalledTimes(2);
  });

  it('reserves ten percent of the budget and resumes after reset', async () => {
    let now = 1000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { p0: { pullRequest: { state: 'OPEN' } } } }), {
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '500', 'x-ratelimit-reset': '120' },
    }));
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: fetcher, now: () => now });
    await client.fingerprints([target(1)]);
    await expect(client.fingerprints([target(1)])).rejects.toMatchObject({ rateLimited: true, retryAt: 120000 });
    now = 120001;
    await client.fingerprints([target(1)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes GraphQL rate limits delivered with HTTP 200', async () => {
    const client = new GithubWatchClient({ token: async () => 'secret', now: () => 0,
      fetch: async () => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'limit reached' }] })) });
    await expect(client.fingerprints([target(1)])).rejects.toMatchObject({ rateLimited: true, retryAt: 60000 });
  });

  it('keeps healthy aliases when one PR is inaccessible', async () => {
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: async () => new Response(JSON.stringify({
      data: { p0: null, p1: { pullRequest: { state: 'OPEN' } } }, errors: [{ type: 'NOT_FOUND', message: 'private' }],
    })) });
    const result = await client.fingerprints([target(1), target(2)]);
    expect([...result.keys()]).toEqual(['github.com/acme/app/2']);
  });

  it('exposes 5xx and enforces a timeout signal on every request', async () => {
    const client = new GithubWatchClient({ token: async () => 'secret', fetch: async (_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response('private server text', { status: 503 });
    } });
    await expect(client.fingerprints([target(1)])).rejects.toThrow('HTTP 503');
  });
});
