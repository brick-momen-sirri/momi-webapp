# Seedance 2.5 prompt skill provenance

- Upstream skill: `sd25-pe`
- Upstream version: `0.1.1`
- Publisher: Seedance / BytePlus ModelArk
- Retrieved: `2026-10-01`
- Source catalog: `https://arkdocs-en.tos-ap-southeast-1.volces.com/skills/`
- Documentation: `https://docs.byteplus.com/en/docs/ModelArk/ark-document-skills`
- Original SHA-256: `EC77264F589B0AC0B5620964F47CC046C292D9A14706C234067645DFD3547601`
- Runtime SHA-256: `02ECE64D1174C33DE27E47F8F88939DE917C45E2E15B32FF5D02CB3582A39867`

The runtime copy is pinned for reproducible production behavior. The upstream
`Self-update before triggering` section was removed because application requests
must never execute package-manager commands or silently change prompt policy.
All prompt-writing instructions from `Purpose` onward are unchanged.

To review an update, download the new upstream skill into a temporary directory,
compare it with `SKILL.md`, record the new version and hash here, remove the
self-update section, then run the prompt-service tests before committing it.
