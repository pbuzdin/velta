// backend-github.js — GitHub adapter for Velta CMS.
//
// The CMS talks to its git host through exactly four operations, all JSON
// over HTTP; the contract is documented at velta.cc/cms/. Any host whose
// API can answer these four can run the CMS — implement them and swap the
// module. Content crosses this boundary as base64 in both directions;
// `sha` is the optimistic-concurrency token (put with a stale sha must
// fail rather than overwrite).

export function createGithubBackend({ repo, branch, getToken }) {
  const API = `https://api.github.com/repos/${repo}/contents`;

  async function call(path, opts = {}) {
    const headers = { Accept: "application/vnd.github+json", ...opts.headers };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (!res.ok) {
      let msg = `GitHub API ${res.status}`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch {}
      if (res.status === 401) msg = "Unauthorized — the token is missing or lacks Contents read/write.";
      throw new Error(msg);
    }
    return res.json();
  }

  return {
    name: "github",

    /** Directory listing (root when dir is "") — [{path, name, type, size, sha}]. */
    async list(dir) {
      return call(`${dir ? "/" + dir : ""}?ref=${branch}`);
    },

    /** File — {path, name, sha, content(base64)}. */
    async get(path) {
      return call(`/${path}?ref=${branch}`);
    },

    /** Create/update = one commit on the branch; returns the new sha. */
    async put(path, message, contentB64, sha) {
      const body = { message, content: contentB64, branch };
      if (sha) body.sha = sha;
      const r = await call(`/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.content.sha;
    },

    /** Delete = one commit on the branch. */
    async del(path, message, sha) {
      await call(`/${path}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sha, branch }),
      });
    },
  };
}
