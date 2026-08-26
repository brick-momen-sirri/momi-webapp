// Answer "is the offsite backup leg actually able to write?" in one command,
// and when it cannot, say which of the plausible causes it is.
//
// Why this exists: the offsite leg died on 2026-08-21 18:48 UTC and stayed dead
// for six days while every local snapshot passed `integrity: ok`. The only
// symptom was an hourly `backup_failed` alert, and the only way to learn the
// actual reason was to open azcopy's own job log. That is a bad loop to be in
// while deciding whether a SAS swap worked, because the next real answer is up
// to an hour away and arrives as a log line nobody is watching.
//
// So this probes the data plane directly and maps the response to a cause. The
// mapping is not guesswork: each failure mode below was distinguished against
// the live container on 2026-08-26 by comparing a permission the SAS carries
// (`r`) with one it does not (`l`). Azure reports a permission the SAS never
// had and a permission it claims but cannot use with the *same* error code
// (AuthorizationPermissionMismatch), which is exactly why "403" alone never
// narrowed anything.
//
// The SAS is read from the environment, never from argv -- a container SAS is a
// credential, and a command line is world-readable on this host and lands in
// shell history. Nothing here prints the signature.
//
// Read-only by default. --write is opt-in and, on a SAS without `d`, leaves the
// probe blob behind permanently; see the warning it prints.
//
//   node scripts/verifyOffsiteBackup.mjs
//   node scripts/verifyOffsiteBackup.mjs --env BACKUP_AZURE_SAS_URL_CANDIDATE
//   node scripts/verifyOffsiteBackup.mjs --write

const SAS_QUERY_KEYS = "sig|sv|sp|st|se|sr|srt|ss|spr|sip|si|skoid|sktid|skt|ske|sks|skv";

// A blob the media leg has written under the configured prefix since the first
// cycle. Used as the "read something that really exists" probe, because a 404 on
// a made-up name proves authorization but not that the container holds anything.
const KNOWN_OBJECT = "media/restore-index.json";

function parseArgs(argv) {
  const args = { env: "BACKUP_AZURE_SAS_URL", prefix: process.env.BACKUP_AZURE_PREFIX?.trim() || "momi-backend", write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") args.write = true;
    else if (argv[i] === "--env") args.env = argv[++i];
    else if (argv[i] === "--prefix") args.prefix = argv[++i];
  }
  return args;
}

/** Strip anything that could carry the SAS signature out of text bound for the console. */
function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      const queryIndex = candidate.indexOf("?");
      if (queryIndex === -1) return candidate;
      return new RegExp(`(?:^|&)(?:${SAS_QUERY_KEYS})=`, "i").test(candidate.slice(queryIndex + 1))
        ? `${candidate.slice(0, queryIndex)}?[redacted-sas]`
        : candidate;
    })
    .replace(new RegExp(`\\b(${SAS_QUERY_KEYS})=([^&\\s"']+)`, "gi"), "$1=[redacted]");
}

async function request(url, method) {
  try {
    const response = await fetch(url, { method });
    return { status: response.status, code: response.headers.get("x-ms-error-code") ?? null, headers: response.headers };
  } catch (error) {
    return { status: 0, code: "NETWORK", detail: error instanceof Error ? error.message : String(error) };
  }
}

function describeSas(sasUrl) {
  const url = new URL(sasUrl);
  const params = url.searchParams;
  const permissions = params.get("sp") ?? "";
  const kind = params.has("skoid")
    ? "user delegation SAS -- the signing identity's RBAC role is checked too"
    : params.has("si")
      ? `service SAS bound to stored access policy "${params.get("si")}" -- the policy governs permissions, not sp`
      : "ad-hoc service SAS signed with an account key";

  const expiry = params.get("se") ? new Date(params.get("se")) : null;
  const start = params.get("st") ? new Date(params.get("st")) : null;
  const now = new Date();

  return {
    url,
    container: url.pathname.replace(/^\//, ""),
    permissions,
    kind,
    expired: expiry ? expiry <= now : false,
    notYetValid: start ? start > now : false,
    expiry,
    canWrite: /[cw]/.test(permissions),
    canList: permissions.includes("l"),
  };
}

/**
 * Turn the probe results into the one sentence worth acting on.
 *
 * Ordered most-specific first. The cases are separated by which probe fails
 * rather than by error code alone, because the codes overlap: a permission the
 * SAS never carried and a permission it carries but cannot exercise both come
 * back as AuthorizationPermissionMismatch.
 */
function diagnose({ sas, authProbe, knownProbe, listProbe, writeProbe }) {
  if (authProbe.code === "NETWORK") {
    return ["FAIL", `Cannot reach ${sas.url.hostname}: ${authProbe.detail}. Check egress and DNS before anything else.`];
  }
  if (sas.expired) return ["FAIL", `The SAS expired at ${sas.expiry?.toISOString()}. Mint a new one.`];
  if (sas.notYetValid) return ["FAIL", "The SAS start time (st) is in the future. Check the host clock and the SAS."];

  if (authProbe.code === "AuthenticationFailed") {
    return ["FAIL", "The signature was rejected: the account key that signed this SAS has been rotated, or the SAS is malformed. Mint a new one from a current key."];
  }
  if (authProbe.code === "KeyBasedAuthenticationNotPermitted") {
    return ["FAIL", "The account has allowSharedKeyAccess disabled, so no account-key SAS can work. Re-enable it, or move this leg to a user delegation SAS / managed identity."];
  }
  if (authProbe.code === "AuthorizationFailure") {
    return ["FAIL", "Authorization refused before permissions were considered -- this is the shape of a storage firewall / network rule. Add this host's egress IP to the account's allowed networks."];
  }
  // Read is the permission the backup leg has always carried, so if it cannot
  // read, nothing below is diagnostic yet.
  if (authProbe.status !== 404 && authProbe.status !== 200) {
    return ["FAIL", `Unexpected ${authProbe.status} ${authProbe.code ?? ""} on a plain read. Investigate before trusting anything else here.`];
  }

  const readsWork = authProbe.status === 404 || authProbe.status === 200;
  const writeRefused = writeProbe && writeProbe.status === 403;

  if (writeProbe && writeProbe.status >= 200 && writeProbe.status < 300) {
    return ["PASS", "A real write succeeded. The offsite leg is working; the next scheduled cycle should upload."];
  }
  if (writeRefused && readsWork) {
    return [
      "FAIL",
      "Reads succeed and writes are refused with the same code Azure uses for a permission the SAS never carried. " +
        "Azure is evaluating this SAS as read-only. Mint a fresh container SAS with racwl and swap it in; if a brand-new SAS " +
        "is refused identically, the restriction is on the account or container rather than the token.",
    ];
  }
  if (!sas.canWrite) {
    return ["FAIL", `The SAS permission string is "${sas.permissions}" and carries neither c nor w. It cannot upload at all.`];
  }
  if (readsWork && !writeProbe) {
    return [
      "UNKNOWN",
      "Reads work and the SAS claims write permission, but no write was attempted. Re-run with --write to settle it. " +
        (listProbe && listProbe.status === 403
          ? "Note the list probe was refused, which is expected when the SAS omits l."
          : ""),
    ];
  }
  return ["UNKNOWN", "No rule matched these probes. Report the table above."];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sasUrl = process.env[args.env]?.trim();
  if (!sasUrl) {
    console.error(`${args.env} is not set in this process environment.`);
    console.error("Set it in the shell you are running from -- do not pass a SAS on the command line.");
    process.exitCode = 1;
    return;
  }

  let sas;
  try {
    sas = describeSas(sasUrl);
  } catch {
    console.error(`${args.env} is not a URL.`);
    process.exitCode = 1;
    return;
  }

  const root = `${sas.url.origin}${sas.url.pathname}`;
  const query = sas.url.search;
  const withPath = (blobPath) => `${root}/${blobPath}${query}`;

  console.log(`account   : ${sas.url.hostname}`);
  console.log(`container : ${sas.container}`);
  console.log(`kind      : ${sas.kind}`);
  console.log(`sp        : ${sas.permissions}   (write=${sas.canWrite ? "yes" : "NO"}, list=${sas.canList ? "yes" : "no"})`);
  console.log(`expires   : ${sas.expiry ? sas.expiry.toISOString() : "(none)"}${sas.expired ? "  ** EXPIRED **" : ""}`);
  console.log("");

  const LABEL_WIDTH = 44;
  const row = (label, result) =>
    console.log(`  ${label.padEnd(LABEL_WIDTH)} ${String(result.status).padEnd(5)} ${result.code ?? "OK"}${result.detail ? " -- " + redact(result.detail) : ""}`);

  console.log("probes");
  // A made-up name: 404 proves the read permission was honoured, since an
  // unauthorised read is refused before existence is considered.
  const authProbe = await request(withPath("__verify-offsite-does-not-exist"), "HEAD");
  row("read authorization (expect 404)", authProbe);

  const knownProbe = await request(withPath(`${args.prefix}/${KNOWN_OBJECT}`), "HEAD");
  row(`read ${KNOWN_OBJECT} (expect 200)`, knownProbe);
  if (knownProbe.status === 200) {
    console.log(`  ${"".padEnd(LABEL_WIDTH)}       last written ${knownProbe.headers.get("last-modified")}`);
  }

  // Control. With `l` absent this is expected to fail, and its error code is the
  // reference for "a permission this SAS does not have".
  const listProbe = await request(`${root}${query}&restype=container&comp=list&maxresults=1`, "GET");
  row(`list container (${sas.canList ? "expect 200" : "control, expect 403"})`, listProbe);

  let writeProbe = null;
  if (args.write) {
    console.log("");
    console.log("  NOTE: --write uploads a small probe blob. This SAS has no `d` permission,");
    console.log("        so the probe blob cannot be removed afterwards and will persist.");
    const name = `${args.prefix}/_verify-probe-${new Date().toISOString().replaceAll(":", "-")}.txt`;
    const url = withPath(name);
    const response = await fetch(url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
      body: "offsite backup write probe\n",
    }).catch((error) => ({ status: 0, headers: new Headers(), _error: error }));
    writeProbe = { status: response.status, code: response.headers?.get?.("x-ms-error-code") ?? null };
    row("write a probe blob", writeProbe);
  }

  const [verdict, message] = diagnose({ sas, authProbe, knownProbe, listProbe, writeProbe });
  console.log("");
  console.log(`${verdict}: ${message}`);
  if (verdict === "FAIL") process.exitCode = 1;
}

await main();
