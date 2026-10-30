# Git from the browser: logging in and pushing to GitHub and Forgejo

Researched 2026-10-30. Sources (abbreviations used below):

- **GHD**: GitHub Docs source, `github/docs` @ `5ecebc9` (2026-10-30), read from GitHub because
  docs.github.com, github.blog and the github.com community pages are blocked from this sandbox.
  Paths are under `content/` or `data/`. Each path maps to `https://docs.github.com/en/<path without .md>`.
- **OAPI**: GitHub's OpenAPI description, `github/rest-api-description` main,
  `descriptions/api.github.com/api.github.com.json`, plus the generated permission tables in
  `github/docs` `src/github-apps/data/fpt-2026-03-10/*.json`.
- **FJ17 / FJ12**: Forgejo source at tags **v17.0.1** (`363f3dc`, 2026-10-26) and **v12.0.4**
  (`39aca97`). forgejo.org, codeberg.org and code.forgejo.org are all blocked here, so the source
  was read from the GitHub mirror `qundao/mirror-forgejo`. Mirror check: its v1.20.0 and v1.21.11-2
  tags match the commit hashes that proxy.golang.org recorded from codeberg.org
  (`e627f16…` and `cd36b74…`), and its v12.0.4 and v13.0.5 hashes match an independent mirror
  (`yonasBSD/forgejo`). The key checks were also re-run on the raw files of v13.0.5, v14.0.3,
  v15.0.11 and v16.0.7.
- **chi-cors**: `github.com/go-chi/cors` v1.2.2, the version Forgejo pins (`FJ17 go.mod:47`), from
  proxy.golang.org.
- **IG**: `isomorphic-git` 1.44.8 `index.js`. **CP**: `@isomorphic-git/cors-proxy` 3.0.3. Both come
  from registry.npmjs.org tarballs.
- **GL**: GitLab source, `gitlabhq/gitlabhq` master mirror (`config/application.rb`).
  **git**: `git/git` master (`http-backend.c`).
- **MDN**: `mdn/content` main. **Fetch**: `whatwg/fetch` `fetch.bs`. **OWASP**: CheatSheetSeries
  `HTML5_Security_Cheat_Sheet.md`.

Not reachable: forgejo.org docs, codeberg.org, man.sr.ht, github.blog and docs.github.com.
api.github.com and github.com/login/* can't be probed live because the sandbox proxy answers those
requests itself.

---

## Verdict

"Get" means obtaining the token, "use" means pushing with it. **REST** is GitHub's Git Data API or
Forgejo's `POST /repos/{o}/{r}/contents`. **Smart HTTP** is `isomorphic-git` against
`…/info/refs` and `…/git-receive-pack`.

| Auth | Plain tab | With extension | Needs a server? | Transport |
|---|---|---|---|---|
| **GitHub PAT** (fine-grained, *Contents: write*, one repo) | **Get**: the user pastes it. **Use**: yes, over REST | Yes, REST and smart HTTP | No | REST works from the tab (api.github.com sends `ACAO: *`). Smart HTTP only through the extension or a proxy, because github.com git endpoints send no CORS headers |
| **GitHub OAuth App, web flow + PKCE** | **Get**: no. The token endpoint requires `client_secret` even with PKCE and is documented as having no CORS preflight support. **Use**: REST yes | Yes, but only if the client secret ships in the page (GitHub's own advice for public clients) | **Yes**, unless the secret is shipped: a tiny server that holds the secret and exchanges the code | Same as the PAT once obtained |
| **GitHub device flow** (OAuth App or GitHub App) | **Get**: no. No CORS on `/login/device/code` or `/login/oauth/access_token` (not verified live, see §1c) | **Yes, and no secret is needed** | Only a dumb CORS relay for those two endpoints. No secret | Same as the PAT |
| **GitHub App user token** | **Get**: no (same endpoints as above). **Use**: REST yes | Yes. Device flow, then refresh without a secret; or web flow + PKCE + shipped secret | Yes for the web flow if the secret is not shipped. Refreshing a web-flow token also needs the secret | Same as the PAT. The token expires after 8 h (refresh token: 6 months) and only reaches repos where the app is installed |
| **Forgejo access token** (`write:repository`) | **Get**: the user pastes it. **Use**: yes, if the admin sets `[cors]` (REST) and/or `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` (smart HTTP) | Yes, with no server config | No | Both. Smart HTTP also needs `REQUIRE_SIGNIN_VIEW = false` (§2a) |
| **Forgejo OAuth2, public client + PKCE** | **Get**: yes, if `[cors] ENABLED` (it covers `/login/oauth/access_token`). No secret. **Use**: as for the access token | Yes | No | Same as the access token. Access token lasts 1 h, refresh token 730 h |

Bottom line:
- **Forgejo can do everything from a plain tab**, because the user administers it.
  - Set `[cors] ENABLED=true`, `ALLOW_DOMAIN=https://fl0rek.github.io` and
    `[repository] ACCESS_CONTROL_ALLOW_ORIGIN=https://fl0rek.github.io`.
  - Register a public OAuth2 app (PKCE is mandatory for public apps). Push over smart HTTP.
- **GitHub from a plain tab only works with a pasted token over REST.**
  - Any OAuth-style login needs either the extension (device flow, no secret) or a server.

## 0. Constraints that shape every option

- **The origin is `https://fl0rek.github.io`, and every Pages site of that account shares it.**
  Project sites live at `http(s)://<owner>.github.io/<repositoryname>`
  (GHD `pages/getting-started-with-github-pages/what-is-github-pages.md:55`). Because of that:
  - Anything kept in localStorage or IndexedDB, and any CORS allow-list entry, is shared with
    every other `fl0rek.github.io/*` site.
  - The extension's content script also matches `https://fl0rek.github.io/*`
    (`prototype/extension/manifest.json`). Any of those sites can therefore drive the relay.
- **Authorization must be listed explicitly in the server's allowed headers.** `Authorization` is a
  "CORS non-wildcard request-header name" (Fetch `fetch.bs:1145-1146`). MDN puts it plainly: it
  "doesn't accept wildcard and always needs to be listed explicitly"
  (MDN `web/http/reference/headers/access-control-allow-headers`).
- **Which requests need a preflight.** `Content-Type` is only safelisted for
  `application/x-www-form-urlencoded`, `multipart/form-data` and `text/plain`
  (Fetch `fetch.bs:1015-1051`).
  - Any JSON REST call, and any git `POST` (`application/x-git-receive-pack-request`), is
    preflighted.
  - A form-encoded OAuth token `POST` with no `Authorization` header is not preflighted. It still
    needs `Access-Control-Allow-Origin` on the response.
- **Headers isomorphic-git sends.**
  - On every request: `Authorization: Basic …` when credentials are known (IG `index.js:9958-9960`).
    The header is built as `Basic base64(username:password)` (IG `:9561-9562`).
  - On the POST: `content-type: application/x-<service>-request` and
    `accept: application/x-<service>-result` (IG `:10072-10073`).
  - `fetch` and `push` use protocol v1 (`protocolVersion: 1`, IG `:10684`, `:14930`).
  - `getRemoteInfo2` and `listServerRefs` default to v2 (IG `:12768`, `:13713`). With v2 they add a
    **`Git-Protocol: version=2`** header (IG `:9961-9962`), which Forgejo's git CORS does not allow
    (§2a). Pass `protocolVersion: 1` or avoid those two calls against Forgejo.

## 1. GitHub

### 1a. api.github.com CORS

- "The REST API supports cross-origin resource sharing (CORS) for AJAX requests from any origin."
  (GHD `rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests.md:19`)
- Documented preflight response (same file `:31-41`):
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With`
  - `Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE`
  - `Access-Control-Expose-Headers: ETag, Link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval`
  - `Access-Control-Max-Age: 86400`
- What follows from that:
  - `Authorization: Bearer <token>` works from a tab.
  - The origin is `*`, so cookies are never involved.
  - `Retry-After` is **not** in the documented expose list, so JS can only read `x-ratelimit-*`.
- **Unverified:** whether the live preflight also allows `X-GitHub-Api-Version`. It is not in the
  documented list, and api.github.com can't be probed from here.
  - Safe choice: omit the header. Requests without it use the default version
    (GHD `rest/about-the-rest-api/api-versions.md:37`).
  - api.github.com currently offers `2022-11-28` and `2026-03-10` (`src/rest/lib/config.json`).

### 1b. Git Data API (all from OAPI)

**Endpoints**

- **Create blob**: `POST /repos/{owner}/{repo}/git/blobs` with `{content, encoding: "utf-8"|"base64"}`.
- **Create tree**: `POST /repos/{owner}/{repo}/git/trees` with `{base_tree?, tree:[{path, mode, type, sha|content}]}`.
  - `sha` is nullable: "If the value is `null` then the file will be deleted."
  - Inline `content` makes GitHub "write this blob out". `sha` and `content` are mutually exclusive.
  - With `base_tree`: "Entries defined in the `tree` parameter will overwrite items from `base_tree` with the same `path`."
  - Without it: "all files which were a part of the parent commit's tree and were not defined in the `tree` parameter will be listed as deleted."
  - "Returns an error if you try to delete a file that does not exist."
- **Create commit**: `POST /repos/{owner}/{repo}/git/commits` with `{message, tree, parents[], author{name,email,date}, committer{…}, signature?}`.
  - `date` is ISO 8601 `YYYY-MM-DDTHH:MM:SSZ`.
  - parents: "If omitted or empty, the commit will be written as a root commit … for a merge
    commit, an array of more than one."
  - `committer` defaults to `author`, and `author` defaults to the authenticated user and the
    current time. So original history-entry times and authors can be kept.
- **Update ref**: `PATCH /repos/{owner}/{repo}/git/refs/{ref}` with `{sha, force:false}`.
  - "Leaving this out or setting it to `false` will make sure you're not overwriting work." It is a
    fast-forward check, not a compare-and-swap on an expected old SHA.
  - Errors are 409 or 422. The exact error text is **unverified**.
- **Create ref**: `POST /repos/{owner}/{repo}/git/refs` with `{ref:"refs/heads/…", sha}`.

**Empty repositories**

- Create ref: "You are unable to create new references for empty repositories, even if the commit
  SHA-1 hash used exists. Empty repositories are repositories without branches." (OAPI `git/create-ref`)
- The Git Database guide (GHD `rest/guides/using-the-rest-api-to-interact-with-your-git-database.md:19-20`):
  "The REST API will return a `409 Conflict` if the Git repository is empty … For an empty
  repository, you can use the `PUT /repos/{owner}/{repo}/contents/{path}` REST API endpoint to
  create content and initialize the repository so you can use the API to manage the Git database."
- **Workaround:** create the repo with a README, or do one `PUT …/contents/<file>` first, then use
  the blob/tree/commit/ref sequence.
- The exact body text "Git Repository is empty." is **unverified**: the docs give only the status.

**Permissions**

- A fine-grained PAT needs **Contents: write** for blob, tree, commit and refs
  (`fine-grained-pat-permissions.json`).
- Writing refs also needs **Workflows: write** if `.github/workflows/*` changes (same file,
  `additional-permissions`).
- GitHub App user tokens are also accepted on all these endpoints (`user-to-server-rest.json`).
- Classic PATs and OAuth tokens need the `repo` scope (OAPI, contents PUT description).

**Limits that matter for automatic push**

- Primary limit: 5,000 requests/h per user, shared by PAT, OAuth and App-on-behalf-of-user calls
  (GHD `data/reusables/rest-api/primary-rate-limit-authenticated-users.md`).
- Secondary limits (GHD `data/reusables/rest-api/secondary-rate-limit-rest-graphql.md`):
  - 100 concurrent requests.
  - 900 points/min per endpoint, where a POST/PATCH costs 5.
  - "no more than 80 content-generating requests per minute and no more than 500 content-generating
    requests per hour".
  - 2,000 OAuth token requests/h.
- One push is at least 3 writes (tree, commit, ref) plus one per binary blob. **Debounce or batch
  history entries.**
  - **Unverified:** whether Git Data writes count as "content-generating".
- Size limits:
  - Git blocks files over 100 MiB and warns at 50 MiB (GHD `data/variables/large_files.yml`).
  - GET blob supports blobs up to 100 MB.
  - A recursive tree is capped at 100,000 entries / 7 MB (OAPI).
  - The create-blob body limit is not documented (**unverified**).

### 1c. Auth options

**Personal access tokens**

- They are used as a password for HTTPS git: "the username is not used to authenticate you … If
  you do not enter a username, you will receive an error"
  (GHD `authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens.md:321-331`).
  - So for isomorphic-git, use any non-empty username, e.g. `x-access-token`, with the token as the
    password.
- Fine-grained PATs: the docs offer a ready "Push access to repositories" template with
  `contents=write` (same file `:144`).
  - Lifetime: 1–366 days or none (`:158`). Limit of 50 per user (`:98`).
  - They lack some features of classic PATs, such as write access to public repos you don't own
    (GHD `data/reusables/user-settings/patv2-limitations.md`). That doesn't matter for the user's
    own repos.
- Per the conclusion of §1a/§1b, a PAT works for REST from a plain tab. Smart HTTP needs the
  extension or a proxy.

**OAuth App, web flow**

- PKCE is now documented (feature flag `pkce_support`, fpt/ghec: GHD `data/features/pkce_support.yml`).
  - `code_challenge_method` "Must be `S256` - the `plain` code challenge method is not supported."
  - `code_verifier` is accepted at the token endpoint
    (GHD `apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps.md:88-89,113`).
- **`client_secret` is still "Required"** at `POST https://github.com/login/oauth/access_token`
  (same file `:109`).
- The same page says: "**CORS pre-flight requests (OPTIONS) are not supported at this time.**" (`:94`)
- GitHub's guidance for single-page apps (GHD `apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app.md:55`):
  "If your app is a public client (… single-page web application), you cannot secure your client
  secret. You do have to ship the client secret in the application's code, and you should use PKCE."
- The 2025-07-14 changelog ("PKCE support for OAuth and GitHub App authentication") could not be
  fetched (github.blog is blocked). Per a search-result summary, it says S256 only, PKCE not
  required, and no public/confidential distinction.
- Redirects:
  - Loopback: "The `redirect_uri` does not need to match the port specified in the callback URL"
    when the callback is `http://127.0.0.1/path`. GitHub advises against `localhost`
    (`authorizing-oauth-apps.md:399-409`).
  - Wildcard (subdirectory) matching is now a per-callback setting
    (GHD `data/reusables/apps/redirect-uri-wildcard-matching.md`).
- **Expiring tokens:** OAuth Apps can now opt in (`offline_access` scope or an app setting).
  - The token lasts 8 h and the refresh token 6 months (`authorizing-oauth-apps.md:45-55`).
  - Refreshing needs `client_secret` "unless the token was generated using the device flow" (`:344`).
- **Scope:** `repo` grants every private repo of the user. There is no per-repo restriction.

**Device flow**

- `POST https://github.com/login/device/code` with `{client_id, scope}`, then poll
  `POST /login/oauth/access_token` with `{client_id, device_code, grant_type=urn:ietf:params:oauth:grant-type:device_code}`.
- "The `client_secret` is not needed for the device flow." (`authorizing-oauth-apps.md:190-263,322`)
- It must be enabled in the app settings (`:180`). The best-practices page (`:59`) says "do not enable the
  device flow … unless you are using the app in a constrained environment", because of phishing risk.
- **CORS on these two endpoints is unverified.** The docs only say OPTIONS preflights are
  unsupported. A form-encoded POST without `Authorization` needs no preflight, but its response
  would still need `Access-Control-Allow-Origin`.
  - The sandbox proxy intercepts `github.com/login/*` (it answered 405/415 itself), so this could not be tested.
  - Treat it as absent. Two-minute check from a normal shell:
    `curl -si -X POST -H 'Origin: https://fl0rek.github.io' -H 'Accept: application/json' -d client_id=<id> https://github.com/login/device/code | grep -i access-control`.

**GitHub App user-to-server tokens**

- The authorize step has the same PKCE parameters. `client_secret` is **Required** at the
  exchange, and there is an optional `repository_id` to narrow the token to one repo
  (GHD `data/reusables/apps/web-app-flow-exchange-code.md`).
- Expiry: "By default, the user access token expires after 8 hours" and the refresh token "expires
  after 6 months"
  (GHD `apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app.md:28,134`).
- Refresh needs `client_secret` "unless the user access token was generated using the device flow"
  (`…/refreshing-user-access-tokens.md:57`).
- Access is the intersection of what the user can reach, the app's permissions, and the accounts
  where the app is installed (`…/authenticating-with-a-github-app-on-behalf-of-a-user.md:34-36`).
  That is the least-privilege option.
- Git over HTTPS: "use the access token as the HTTP password", e.g.
  `https://x-access-token:TOKEN@github.com/owner/repo.git`, with the *Contents* permission
  (GHD `apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app.md:92-97`).
  For OAuth App tokens, "The token is used as the HTTP username"
  (`apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps.md:123`).

**Conclusion for GitHub**

- **(i) Nothing installed:** a pasted PAT (or token), pushing over the Git Data API. There is no
  OAuth login of any kind.
- **(ii) With the extension:**
  - Device flow, with no secret. A GitHub App with device flow gets an 8 h token that refreshes
    without a secret.
  - Or the web flow + PKCE with the client secret embedded, which GitHub sanctions for public
    clients.
  - Plus smart HTTP via isomorphic-git through the relay.
- **(iii) Tiny server:** a code-for-token exchange endpoint that holds the secret (web flow + PKCE),
  or a plain CORS relay for the two device-flow endpoints. The cors.isomorphic-git.org proxy does
  **not** cover these (§4).

## 2. Forgejo (Forgejo source unless marked "Gitea")

### 2a. CORS: two separate settings, unchanged from v12.0.4 to v17.0.1

**Smart HTTP: `[repository] ACCESS_CONTROL_ALLOW_ORIGIN`**

- `CorsHandler()` (FJ17 `routers/web/repo/githttp.go:48-58`; FJ12 `:47-56`):
  `cors.Handler(cors.Options{AllowedOrigins: []string{setting.Repository.AccessControlAllowOrigin}, AllowedHeaders: []string{"Content-Type", "Authorization", "User-Agent"}})`.
  When the value is empty, the handler is a no-op.
- Example ini: "Value for Access-Control-Allow-Origin header, default is not to present. WARNING:
  This may be harmful to your website if you do not give it a right value."
  (FJ17 `custom/conf/app.example.ini:1020-1022`)
- What go-chi/cors does with this config:
  - No methods are given, so it defaults to `GET, POST, HEAD` (chi-cors `cors.go:174-177`). That is
    enough for `info/refs` and `git-*-pack`.
  - `Origin` is added to the allowed headers (`:164`).
  - The value goes through the same matcher as a list: `*` allows any origin, and one `*` inside
    an origin acts as a wildcard (`:136-156`, `utils.go:14-16`). So a single value can't name both
    `https://fl0rek.github.io` and `http://localhost:5173`; only `*` covers both.
  - No `ExposedHeaders` and no credentials.
- Route order (FJ17 `routers/web/githttp.go:41`, identical in v12–v16):
  `ignoreCSRF, requireSignIn, repo.HTTPGitEnabledHandler, repo.CorsHandler(), …`.
  - `requireSignIn` returns 401 when `REQUIRE_SIGNIN_VIEW` is true and the request is not signed in
    (`:15-26`).
  - The router stops the chain once a handler has written (FJ17 `modules/web/handler.go:184-185`).
  - Result: **with `[service] REQUIRE_SIGNIN_VIEW = true`, the credential-less CORS preflight gets
    a 401 without CORS headers, and browser git over smart HTTP fails.** Inferred from the code;
    not run.
  - The REST API is not affected: its CORS middleware runs before authentication (below).
- `DISABLE_HTTP_GIT` blocks the route outright (`HTTPGitEnabledHandler`).

**REST API and the OAuth endpoints: `[cors]`**

- API middleware (FJ17 `routers/api/shared/middleware.go:27-35`; FJ12 `:21-28`): when
  `CORSConfig.Enabled`, it uses `AllowedOrigins = ALLOW_DOMAIN`, `AllowedMethods = METHODS`,
  `AllowedHeaders = ["Authorization","X-Gitea-OTP","X-Forgejo-OTP"] + HEADERS`.
- **Yes, `[cors]` also covers `/login/oauth/access_token`.** The route sits in a group wrapped by
  `optionsCorsHandler()` (FJ17 `routers/web/web.go:723-735`, route at `:732`; FJ12 `:536`; present
  in v13.0.5, v14.0.3, v15.0.11 and v16.0.7).
  - The same handler covers `/login/oauth/keys`, `/introspect`, `/userinfo` and `/.well-known/*`.
  - `optionsCorsHandler` uses `HEADERS` as-is, without adding `Authorization` (`web.go:72-103`).
    That is fine for a public client posting a form body.
  - It answers an OPTIONS request without `Access-Control-Request-Method` with 405.
- Defaults (FJ17 `modules/setting/cors.go:20-24` and `app.example.ini:1248-1274`):
  - `ENABLED=false`, `ALLOW_DOMAIN=*`, `METHODS=GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS`.
  - `MAX_AGE=10m`, `ALLOW_CREDENTIALS=false`, `HEADERS=Content-Type,User-Agent`.
  - The code itself notes that `ALLOW_DOMAIN` "actually works as 'AllowedOrigins'" (`cors.go:13`).
  - The ini comment: "list of requesting origins that are allowed, eg: "https://*.example.com"".

**Recommended config for this prototype**

```ini
[cors]
ENABLED = true
ALLOW_DOMAIN = https://fl0rek.github.io,http://localhost:5173   ; dev port as used
; HEADERS default (Content-Type,User-Agent) is enough; Authorization is always added for /api

[repository]
ACCESS_CONTROL_ALLOW_ORIGIN = https://fl0rek.github.io        ; single value; "*" if dev must work too

[service]
REQUIRE_SIGNIN_VIEW = false                                  ; else git CORS preflight 401s (see above)
```

Gitea, the pre-fork ancestor, has the same two-setting split; this was established before this
research (`routers/web/repo/githttp.go` `CorsHandler`, `routers/web/web.go` `optionsCorsHandler`).

### 2b. Access tokens

**Scopes**

- Scopes are `read:`/`write:` × `activitypub, admin, misc, notification, organization, package, issue, repository, user`,
  plus `all` and `public-only` (FJ17 `models/auth/access_token_scope.go:56-84`).
- For git over HTTP, `httpBase` calls
  `CheckRepoScopedToken(ctx, repo, GetScopeLevelFromAccessMode(accessMode))`, and push needs write
  access (FJ17 `routers/web/repo/githttp.go:86-90,156`). That means **`write:repository`**, and
  `public-only` rejects private repos (FJ17 `services/context/permission.go:144-171`).
- In the API, any POST/PUT/PATCH/DELETE needs the write level (FJ17 `routers/api/v1/api.go:293-300`).
  The `/repos` group needs the repository category (`:1131`). So `POST …/contents` also needs
  **`write:repository`**.
- **Repo-restricted tokens exist from v15** (`AccessToken.ResourceAllRepos`, FJ17
  `models/auth/access_token.go:77`; absent in v12.0.4, v13.0.5 and v14.0.3, present in v15.0.11 and
  v16.0.7). They are enforced through `Reducer().ReduceRepoAccess` (`permission.go:174-193`).

**Basic-auth username rules**

- From FJ17 `services/auth/method/util.go:60-67`, same logic in FJ12 `services/auth/basic.go:62-70`:
  "we'll use the password as the access token (or oauth token), but if the password is empty or
  `x-oauth-basic`, we'll use the username as a token."
- So `{username: <anything>, password: <token>}` works, and so does `{username: <token>}`.
- v17's git auth group also accepts `Authorization: Bearer|token <t>` (`PermitBearer: true`,
  FJ17 `routers/web/web.go:176-201`). Basic is the form that works on every version.
- Passwords over Basic are refused for users with 2FA (`githttp.go:162-165`). Tokens are not affected.

### 2c. OAuth2 provider

**Public clients and PKCE**

- An app has `ConfidentialClient` (DB default true, FJ17 `models/auth/oauth2.go:41`). In the API it
  is `confidential_client` on `POST /api/v1/user/applications/oauth2`
  (FJ17 `modules/structs/user_app.go:40-44`).
- The UI hint reads: "Confidential client. Select for apps that keep the secret confidential, such
  as web apps. Do not select for native apps…" (FJ17 `options/locale/locale_en-US.ini:904`).
  **For the browser prototype: leave it unchecked.**
- **PKCE is mandatory for public clients.** With no `code_challenge_method`, the server returns
  `invalid_request`, "PKCE is required for public clients" (FJ17 `routers/web/auth/oauth.go:500-513`;
  present in every version v12–v16).
- `S256` and `plain` are both accepted (`oauth.go:478-479`, `models/auth/oauth2.go:437-444`). Use S256.
- The secret is only checked when `app.ConfidentialClient` is set (`oauth.go:853`, refresh at `:774`).
- Grant types are "Only refresh_token or authorization_code" (`oauth.go:750-758`). **Forgejo has no
  device flow.**

**Redirect URIs**

- Matching is exact (case-insensitive, trailing `/` ignored).
- For public clients only, an `http` loopback **IP literal** matches on any port
  (FJ17 `models/auth/oauth2.go:147-184`, `ip.IsLoopback()`).
  - `http://localhost:5173/…` is not an IP literal, so it needs an exact registration.
  - `http://127.0.0.1/cb` covers every port.
- Register `https://fl0rek.github.io/gfs/<callback>` exactly.

**Tokens and expiry**

- Defaults (FJ17 `modules/setting/oauth2.go:106-109`):
  - Access token: 3600 s. The ini comment: "Lifetime of an OAuth2 access token in seconds".
  - Refresh token: 730 h. The ini comment: "…in hours" (`app.example.ini:578-585`).
  - `INVALIDATE_REFRESH_TOKENS` is **true** in code, but the example ini shows `false`; the code
    default applies when unset. With it on, each refresh token is single-use (`oauth.go:828-833`).
- Refresh for a public client needs no secret (`oauth.go:774`).
- Token endpoint CORS: see §2a.

**Where OAuth tokens work**

- OAuth2 is in the git auth group (`web.go:176-178`), so access tokens work for git over HTTP, via
  the Basic password or Bearer. They also work for the API.

**Scopes on OAuth tokens**

- Requested `scope` values that aren't OIDC scopes (`openid`, `profile`, `email`, `groups`) are
  mapped to token scopes: `write:repository`, `public-only` and so on. If none are given, the scope
  falls back to `all` (FJ17 `services/auth/method/oauth2.go:29-67,106-112`).
- **The API honours them in all versions.** Over git HTTP:
  - **v12–v14 do not.** `CheckRepoScopedToken` only applies "a personal access token but not oauth2
    token" (FJ12 `services/context/permission.go:115-121`; same in v13.0.5 and v14.0.3).
  - From v15.0.11 the grant scopes are enforced for git too.
- So request `scope=write:repository`. On v12–v14, the OAuth token is effectively full-user over git.

### 2d. Multi-file commit API (fallback when git CORS is not set)

- `POST /api/v1/repos/{owner}/{repo}/contents` ("Modify multiple files in a repository", FJ17
  `routers/api/v1/repo/file.go:447-545`). Route at `api.go:1095`: `reqToken()`, branch-writer and
  quota checks. Present in FJ12 (`api.go:1372`).
- Body `ChangeFilesOptions` (FJ17 `modules/structs/repo_file.go:10-25,72-95`):
  - `files: [{operation: "create"|"update"|"delete", path, content (base64), sha (required for update/delete), from_path}]`
  - `message`, `branch` (default: the default branch), `new_branch`
  - `author{name,email}`, `committer{…}`, `dates{author, committer}`
  - `signoff`, and since some version after v12, `force_overwrite_new_branch`
- One call produces one commit. Concurrency is checked per file through `sha` (`ErrSHADoesNotMatch`).
  There is no "expected parent commit" field in the API.
- **Works on empty repositories:** `ChangeRepoFiles` treats `repo.IsEmpty` specially and clears the
  flag after the first commit (FJ17 `services/repository/files/update.go:97,168,282-284`). This is
  unlike GitHub's 409.
- Needs `[cors]` and `write:repository`.

## 3. Other git servers

- **GitLab** (GL `config/application.rb:539-617`):
  - Rack::Cors allows `/api/*` from any origin with `credentials: false`, `headers: :any`,
    `methods: :any`.
  - It also allows `/oauth/token` and `/oauth/revoke` from `*`, commented "Cross-origin requests
    must be enabled for the Authorization code with PKCE OAuth flow when used from a browser".
  - There is no rule for git smart-HTTP paths, and `repositories/git_http_controller.rb` has no
    CORS code. So from a tab: REST yes (a multi-action commit is `POST /projects/:id/repository/commits`,
    GL `lib/api/commits.rb:360`), PKCE login yes, smart HTTP no.
  - Inferred from the code; no gitlab.com docs were reachable.
- **sourcehut:** **unverified.** man.sr.ht is unreachable. A search-result summary of its "set up
  account and git" tutorial says pushes go over SSH, with HTTPS clone read-only, so browser push is
  probably impossible regardless of CORS. Nothing found about CORS.
- **Plain `git http-backend`:** the CGI emits no CORS headers. `http-backend.c` and
  `Documentation/git-http-backend.adoc` contain no "Access-Control" at all (git master). The fronting
  web server (Apache, nginx, Caddy) must add `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Headers: Authorization, Content-Type` and answer OPTIONS. Its auth is
  whatever the web server does, typically Basic.

## 4. Public CORS proxies (`cors.isomorphic-git.org`)

- What it is: "This is the software running on https://cors.isomorphic-git.org/ - a free service …
  that enables cloning and pushing repos in the browser … it blocks requests that don't look like
  valid git requests." (CP `README.md:3-8`)
- What it allows (CP `index.js:63-89`):
  - `GET …/info/refs?service=git-upload-pack|git-receive-pack`.
  - `POST …/git-upload-pack|git-receive-pack` with the matching `application/x-git-*-request` content type.
  - Preflights for those.
  - **Nothing else**, so not GitHub's or Forgejo's OAuth token endpoints and not REST.
- How it relays:
  - The URL form is `${corsProxy}/${url without scheme}` (IG `index.js:9879-9882`).
  - Upstream is always `https://…` unless the host is listed in `INSECURE_HTTP_ORIGINS` (CP `:153-155`).
  - It forwards an allow-list of request headers that **includes `authorization`** (CP `:8-27,141-146`).
  - It answers with `Access-Control-Allow-Origin: *` by default (`ALLOW_ORIGIN`, CP `:5`) and no
    credentials.
- **Security consequence:** TLS ends at the proxy, which then sends the `Authorization: Basic`
  header (with the token) upstream itself. **The proxy operator sees every token and every byte
  pushed.**
  - Only acceptable with a self-hosted instance (`npx @isomorphic-git/cors-proxy`, or the
    Dockerfile in the package) on a host the user trusts, ideally with `ALLOW_ORIGIN` set to the
    page origin.
  - It also can't reach a private Forgejo unless that instance is publicly routable.

## 5. Token storage in the browser

- **The Worker has no localStorage.** MDN's list of APIs available in workers includes IndexedDB and
  does not list Web Storage (MDN `web/api/web_workers_api/functions_and_classes_available_to_workers:60`).
  A token used by the Worker either lives in IndexedDB or is passed in from the page.
- **localStorage:** scoped to the origin and "has no expiration time"; in private browsing it is
  cleared when the last private tab closes (MDN `web/api/window/localstorage:11-13`).
- **sessionStorage:** per tab, "Closing the tab/window ends the session and clears the data"
  (MDN `web/api/window/sessionstorage:13-17`).
- **Web Storage generally** (OWASP `HTML5_Security_Cheat_Sheet.md:47-53`): "A single Cross Site
  Scripting can be used to steal all the data in these objects … it's recommended not to store
  sensitive information in local storage." IndexedDB has the same XSS exposure, since script on the
  origin can read it.
- **On this origin, all of the above is shared with every `fl0rek.github.io/*` Pages site** (§0).
  Practical choices:
  - Short-lived OAuth tokens (Forgejo: 1 h access, rotating refresh; GitHub App: 8 h).
  - Narrow scopes: `write:repository` + repo-restricted on Forgejo v15+; fine-grained single-repo
    *Contents: write* on GitHub.
  - Or a custom domain for the prototype, which gives it its own origin.
- **WebExtension storage:**
  - `storage.*` values "are scoped to the extension, not to a specific domain"
    (MDN `mozilla/add-ons/webextensions/api/storage:14`), so another Pages site can't read them
    directly.
  - But "The storage area is not encrypted and shouldn't be used for storing confidential user
    information." (`:27`)
  - `storage.local` is cleared on uninstall (`…/storage/local:16`).
  - `storage.session` is "stored in memory … not persisted to disk", and "By default, it's not
    exposed to content scripts" (`…/storage/session:9-14`).
- **Extension as token holder:** keep the token in the background script (`storage.session` or
  `storage.local`) and have it add `Authorization` to relayed requests. The page then never sees
  the token.
  - Caveat: the relay currently serves any `https://fl0rek.github.io/*` page, so it should be
    narrowed to the gfs path or check the sender before attaching credentials. This is a design
    inference, not a sourced fact.

## Unverified items (and why)

- **Whether github.com `/login/device/code` and `/login/oauth/access_token` POST responses carry
  `Access-Control-Allow-Origin`.** The docs only say OPTIONS preflights are unsupported, and the
  sandbox proxy intercepts github.com/login/*. Treated as "no".
- **Whether the live api.github.com preflight allows `X-GitHub-Api-Version`.** It is not in the
  documented header list, and api.github.com is blocked here.
- **The exact 409/422 body texts from the Git Data API** ("Git Repository is empty.",
  non-fast-forward).
- **Whether Git Data writes count toward the 80/min and 500/h content-creation limit.**
- **The GitHub PKCE changelog text.** github.blog is blocked; only a search summary was seen. The
  GitHub Docs source covers the same facts.
- **The Forgejo `REQUIRE_SIGNIN_VIEW` preflight failure.** It follows from reading the code (route
  order plus chain abort), not from running a server.
- **Forgejo docs site wording** (forgejo.org is blocked). Settings were taken from the source and
  `app.example.ini` instead.
- **sourcehut, entirely.** man.sr.ht is unreachable.
