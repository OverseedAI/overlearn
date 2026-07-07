# Release Procedure

Overlearn release versions come from the root `package.json`. The desktop
Tauri config must keep the same version.

1. Bump `package.json` and `src-tauri/tauri.conf.json` to the release version.
2. Run `bun run check:version` to verify they match.
3. Create and push a matching tag:

   ```sh
   git tag v<version>
   git push origin v<version>
   ```

4. The `Release` workflow creates the GitHub Release notes for the tag.
5. The `Release Artifacts` workflow runs on `v*` tags and can also be started
   manually with `workflow_dispatch`. It builds unsigned desktop artifacts on
   Linux and macOS. The internal sidecar is built as part of the desktop
   artifact job.

Desktop artifacts are attached to the `Release Artifacts` workflow run:

- Linux: `.deb` and `.AppImage`
- macOS: `.dmg` and `.app`

Signing, notarization, and auto-update metadata are not part of this release
flow yet.
