# Fork desktop releases

`Package unsigned desktop` builds macOS ARM64, macOS Intel, and Windows x64. Manual branch builds upload installers and a CLI package set to Actions artifacts (retained for 14 days). Pushing a new `dsh-v*-lechun.N` tag also starts a build.

`Release unsigned desktop` runs after a successful packaging run. If exactly one fork release tag points to the source commit, it publishes the three installers, the CLI tarball, and SHA-256 checksums as a GitHub prerelease. A build without a matching tag remains artifacts-only. Failed builds never publish a release.

To publish an already successful build, run `Release unsigned desktop` from `master`, entering its numeric `run_id` and existing `release_tag`. The tag must point to the exact build commit, and the artifacts must not have expired. This also supports builds made before the publisher workflow existed; no rebuild or moving an existing tag is needed.

Publication is serialized. Assets upload to a draft first, so a failed upload can be retried with the same inputs. An already published release is never silently overwritten. The publisher validates the workflow, repository, event, result, and tag SHA; it does not check out or execute code from downloaded builds. The standard workflow token is sufficient; no personal access token is needed.
