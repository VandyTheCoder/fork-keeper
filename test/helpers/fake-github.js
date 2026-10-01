// In-memory stand-in for the GitHub REST endpoints fork-keeper calls.
// Upstream and fork share one object store, as repos in a fork network do.

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function createFakeGitHub({ fork = 'me/b', upstream = 'org/a', defaultBranch = 'main' } = {}) {
  const commits = new Map(); // sha -> { parents, tree, message }
  const tagObjects = new Map(); // sha -> { target }
  const refs = new Map([[fork, new Map()], [upstream, new Map()]]);
  const repoMeta = {
    [fork]: { fork: true, parent: { full_name: upstream, default_branch: defaultBranch } },
    [upstream]: { fork: false },
  };
  const requests = [];
  const faults = [];
  let counter = 0;
  const nextSha = () => (++counter).toString(16).padStart(40, '0');

  const setRef = (repo, ref, sha) => refs.get(repo).set(ref, sha);
  const getRef = (repo, ref) => refs.get(repo).get(ref);
  const deleteRef = (repo, ref) => refs.get(repo).delete(ref);

  function commit(parents = [], message = 'commit') {
    const sha = nextSha();
    commits.set(sha, { parents, tree: `tree-of-${sha.slice(-6)}`, message });
    return sha;
  }

  function tag(repo, name, target, { annotated = false } = {}) {
    let sha = target;
    if (annotated) {
      sha = nextSha();
      tagObjects.set(sha, { target });
    }
    setRef(repo, `refs/tags/${name}`, sha);
    return sha;
  }

  function fail(method, pathPattern, response, { times = 1 } = {}) {
    faults.push({ method, pathPattern, response, times });
  }

  function ancestors(sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop();
      if (seen.has(s) || !commits.has(s)) continue;
      seen.add(s);
      stack.push(...commits.get(s).parents);
    }
    return seen;
  }

  function mergeBase(base, headAncestors) {
    const queue = [base];
    const seen = new Set();
    while (queue.length > 0) {
      const s = queue.shift();
      if (seen.has(s)) continue;
      seen.add(s);
      if (headAncestors.has(s)) return s;
      queue.push(...(commits.get(s)?.parents ?? []));
    }
    return null;
  }

  function route(method, path, body) {
    let m;
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)$/))) {
      const meta = repoMeta[m[1]];
      return meta ? json(200, { full_name: m[1], ...meta }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/matching-refs\/(heads|tags)$/))) {
      const repoRefs = refs.get(m[1]);
      if (!repoRefs) return json(404, { message: 'Not Found' });
      const prefix = `refs/${m[2]}/`;
      return json(200, [...repoRefs]
        .filter(([ref]) => ref.startsWith(prefix))
        .map(([ref, sha]) => ({ ref, object: { sha, type: tagObjects.has(sha) ? 'tag' : 'commit' } })));
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const [base, head] = [m[2], m[3]];
      if (!commits.has(base) || !commits.has(head)) return json(404, { message: 'Not Found' });
      const baseAnc = ancestors(base);
      const headAnc = ancestors(head);
      const mb = mergeBase(base, headAnc);
      if (base !== head && !mb) return json(404, { message: `No common ancestor between ${base} and ${head}.` });
      const aheadBy = [...headAnc].filter((s) => !baseAnc.has(s)).length;
      const behindBy = [...baseAnc].filter((s) => !headAnc.has(s)).length;
      let status = 'diverged';
      if (base === head) status = 'identical';
      else if (behindBy === 0) status = 'ahead';
      else if (aheadBy === 0) status = 'behind';
      return json(200, { status, ahead_by: aheadBy, behind_by: behindBy, merge_base_commit: mb ? { sha: mb } : null });
    }
    if (method === 'GET' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/commits\/([0-9a-f]+)$/))) {
      const c = commits.get(m[2]);
      if (!c) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[2], tree: { sha: c.tree }, message: c.message, parents: c.parents.map((sha) => ({ sha })) });
    }
    if (method === 'POST' && path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/commits$/)) {
      const sha = nextSha();
      commits.set(sha, { parents: body.parents, tree: body.tree, message: body.message });
      return json(201, { sha });
    }
    if (method === 'POST' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs$/))) {
      const repoRefs = refs.get(m[1]);
      if (repoRefs.has(body.ref)) return json(422, { message: 'Reference already exists' });
      if (!commits.has(body.sha) && !tagObjects.has(body.sha)) return json(422, { message: 'Object does not exist' });
      repoRefs.set(body.ref, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === 'PATCH' && (m = path.match(/^\/repos\/([^/]+\/[^/]+)\/git\/refs\/(.+)$/))) {
      const repoRefs = refs.get(m[1]);
      const ref = `refs/${decodeURIComponent(m[2])}`;
      const current = repoRefs.get(ref);
      if (!current) return json(422, { message: 'Reference does not exist' });
      if (!body.force && !ancestors(body.sha).has(current)) return json(422, { message: 'Update is not a fast forward' });
      repoRefs.set(ref, body.sha);
      return json(200, { ref, object: { sha: body.sha } });
    }
    return json(404, { message: `fake GitHub has no route for ${method} ${path}` });
  }

  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const { pathname, search } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: pathname + search, body, headers: init.headers });
    const fault = faults.find((f) => f.method === method && f.pathPattern.test(pathname) && f.times > 0);
    if (fault) {
      fault.times -= 1;
      return json(fault.response.status, fault.response.body ?? {}, fault.response.headers);
    }
    return route(method, pathname, body);
  }

  return { fetch, commit, tag, setRef, getRef, deleteRef, fail, requests, commits, repoMeta };
}
