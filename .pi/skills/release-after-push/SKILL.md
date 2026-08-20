---
name: release-after-push
description: Publish the next signed pre-1.0 Windows GitHub Release after project changes are committed and pushed. Use whenever the user asks to commit and push, memmit, deploy, push an existing commit, or make a release in this repository.
---

# Release After Push

## Rules

- Prepare the release version before the final commit, then finish the requested commit or memmit flow before releasing.
- Release only a clean `main` commit that exactly matches `origin/main`.
- Choose a unique `v0.MINOR.PATCH` version without asking. Start from the greater of the latest matching tag and the configured app version. Increment MINOR for user-facing capabilities or compatibility changes; increment PATCH for fixes, refactoring, documentation, and maintenance.
- Keep the version without `v` identical in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
- Never move, replace, delete, or force-push a tag or release.
- Never read signing keys, tokens, or secret values. Confirm only that required GitHub Actions secret names exist.
- Stop on failed validation, push, build, signing, or release checks. Keep a failed tag and release, and report the workflow URL.

## Steps

1. Fetch `main` and tags. Compare the changes since the latest `v0.*.*` tag, read the configured app version, and choose the next version from whichever is greater.
2. Before the final commit, set the chosen version without `v` in every version file. Use Windows-native npm and Cargo commands as required by `AGENTS.md`, and include generated lockfile version changes in the same commit.
3. Run the repository validation required by `AGENTS.md`. Finish the commit or memmit flow and push the final commit.
4. Confirm the release state:

```sh
git fetch origin main --tags
git status --short
test "$(git branch --show-current)" = main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git status --short)"
git lfs fsck
```

5. Confirm GitHub authentication and required secret names without reading their values:

```sh
gh auth status
configured_secrets="$(gh secret list --app actions | cut -f1)"
for secret in TAURI_SIGNING_PRIVATE_KEY STREAMSPLEASE_GITHUB_TOKEN; do
  printf '%s\n' "$configured_secrets" | grep -Fx "$secret" >/dev/null || exit 1
done
git tag --list 'v0.*.*' --sort=-version:refname | head -1
```

If the signing key is password-protected, also require `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

6. Confirm the chosen tag and release do not exist:

```sh
version=v0.MINOR.PATCH
test -z "$(git tag --list "$version")"
! git ls-remote --exit-code --tags origin "refs/tags/$version"
! gh release view "$version" >/dev/null 2>&1
```

7. Create and push an annotated tag, then create the release that triggers `.github/workflows/windows-release.yml`:

```sh
git tag -a "$version" -m "Release $version"
git push origin "refs/tags/$version"
gh release create "$version" --verify-tag --generate-notes --title "$version"
```

8. Find the release-triggered workflow and wait for it:

```sh
run_id=
for attempt in $(seq 1 24); do
  run_id="$(gh run list --workflow windows-release.yml --branch "$version" --event release --limit 1 --json databaseId --jq '.[0].databaseId')"
  test -n "$run_id" && break
  sleep 5
done
test -n "$run_id"
gh run watch "$run_id" --exit-status
```

9. Verify that the release targets the tag and contains `latest.json`, Windows installers, and updater signatures:

```sh
gh release view "$version" --json tagName,url,isDraft,isPrerelease,assets
assets="$(gh release view "$version" --json assets --jq '.assets[].name')"
printf '%s\n' "$assets" | grep -Fx latest.json >/dev/null
printf '%s\n' "$assets" | grep -E '\.(msi|exe)$' >/dev/null
printf '%s\n' "$assets" | grep -E '\.sig$' >/dev/null
```

10. When updater or release behavior changed, launch the previously installed Windows release and verify that it discovers, installs, and restarts into the new version. Report when this native check remains outstanding.
11. Report the version, commit, workflow URL, release URL, installer names, validation results, and any outstanding native verification.
