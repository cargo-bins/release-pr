# Action: (Cargo) release-pr

A GitHub Action for creating "Release PRs" for Cargo projects.

## Purpose

This action uses [`cargo-release`](https://github.com/crate-ci/cargo-release) to perform a release
of a Cargo project or a crate, but commits the result to a new branch, and submits that branch as a
Pull Request on the repo.

It is meant to be invoked as a "manual" action (via `workflow_dispatch`).

The result is a PR which can be reviewed, approved, and merged with the same protocol as normal PRs,
avoiding the need for special push permissions for people doing releases. This also provides a
staging ground for drafting release notes, and serves as a kind of pre-release announcement, or an
"intent to release" declaration.

The body and title of the PR can be customised via inputs, or completely overriden using custom
templates.

See the various PRs in the test repo for examples: https://github.com/passcod/cargo-release-pr-test/pulls?q=is%3Apr

## Usage

With a single crate (no workspace):

```yaml
name: Open a release PR
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to release
        required: true
        type: string

jobs:
  make-release-pr:
    permissions:
      id-token: write # Enable OIDC
      pull-requests: write
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: chainguard-dev/actions/setup-gitsign@main
      - name: Install cargo-release
        uses: taiki-e/install-action@v1
        with:
          tool: cargo-release

      - uses: cargo-bins/release-pr@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          version: ${{ inputs.version }}
```

With a workspace:

```yaml
name: Open a release PR
on:
  workflow_dispatch:
    inputs:
      crate:
        description: Crate to release
        required: true
        type: choice
        options:
          - widget
          - gadget
          - budget
          - fidget
          - nugget
      version:
        description: Version to release
        required: true
        type: string

jobs:
  make-release-pr:
    permissions:
      id-token: write # Enable OIDC
      pull-requests: write
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: chainguard-dev/actions/setup-gitsign@main
      - name: Install cargo-release
        uses: taiki-e/install-action@v1
        with:
          tool: cargo-release

      - uses: cargo-bins/release-pr@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          version: ${{ inputs.version }}
          crate-name: ${{ inputs.crate }}
```

## Release configuration

The action does not include a build of `cargo-release` itself. Instead, it's expected that
`cargo-release` be installed into the workflow prior to this action running, as with the usage
examples above. If `cargo-release` is _not_ present when the action runs, it will attempt to install
it with `cargo install` (which can be very slow!). If `cargo-binstall` is available in the workflow,
it will instead attempt to use that to install `cargo-release`.

The action runs `cargo-release` with these CLI options:

- `--verbose`
- `--dependent-version upgrade`
- `--execute`, `--no-confirm` (no dry run)
- `--no-push`, `--no-tag` (only commit)
- `--no-publish` (no publishing to crates.io yet)
- `--allow-branch release/1.2.3` (so that `cargo-release` doesn't refuse to work)
- with working directory set to the root of the crate being released

Otherwise, `cargo-release` will behave as normal. Notably, it will read `release.toml` files where
present, which can provide further configuration. There are two additional restrictions:

You _must not_ disable commit creation, and you _must not_ enable post-release version bumps.

Doing so will break this action.

## Inputs

| Name | Type | Default | Description |
|:-|:-:|:-:|:-|
| `github-token` | String | _required_ | Should be set to `${{ secrets.GITHUB_TOKEN }}`. |
| `version` | String | _required_ | The exact version to release, or any of the [bump levels](https://github.com/crate-ci/cargo-release/blob/master/docs/reference.md#bump-level) `cargo-release` supports. It's recommended to use an exact version. |
| `crate-name` | String | _(discovered)_ | The `name` of the crate to publish. This is required if there is more than one crate in the repo, e.g. for workspaces, unless `crate-path` is provided. |
| `crate-path` | String | _(discovered)_ | The relative (from the repo root) path to the crate to publish. This is required if there is more than one crate in the repo, e.g. for workspaces, unless `crate-name` is provided. |
| `crate-release-all` | Boolean | `false` | Flag to release all crates in the workspace. This option implicitly requires all found crates to have the same version. |
| `pr-title` | String | `release: <%= crate.name %> v<%= version.actual %>` | An [EJS] template string (or a literal string, so long as no EJS tags are present) for the title of the PR. |
| `pr-label` | String | _optional_ | The name of a label to add to the PR. |
| `pr-draft` | Boolean | `false` | Set to `true` to create the PR as Draft. |
| `pr-modifiable` | Boolean | `true` | Set to `false` to disallow maintainers from editing the PR. Note that this is rarely enforceable, as the branch is created in the same repo. |
| `pr-template` | String | _optional_ | An [EJS] template string for the body of the PR. This is mutually exclusive with `pr-template-file`. If neither is provided, the [default template] is used. |
| `pr-template-file` | String | _optional_ | The path to an [EJS] template file for the body of the PR. This is mutually exclusive with `pr-template`. If neither is provided, the [default template] is used. |
| `pr-merge-strategy` | String | `squash` | The merge strategy that should be used to merge the release PR. Note that this action is not involved in merging the PR; this input is only a hint which is rendered by the (default) template. May be either of: `squash`, `merge`, `rebase`, `bors`. |
| `pr-release-notes` | Boolean | `false` | Includes a section in the PR body (with the default template) which can be used to fill in release notes. |
| `check-semver` | Boolean | `false` | Use [`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-check) to check the release before pushing it. For this to work, the current version of the crate must be published to the registry. |
| `git-user-name` | String | `github-actions` | The git user name, which will be used for the release commit. |
| `git-user-email` | String | `github-actions@github.com` | The git user email, which will be used for the release commit. |
| `base-branch` | String | _(discovered)_ | The branch which the release PR will target. Note that the action does _not_ checkout this branch, so mismatches could cause odd behaviour. Defaults to the repo's configured default branch. |
| `branch-prefix` | String | `release` | The prefix to use to name the branch used for the PR. This will be joined onto the `version` input with `/`. |

[EJS]: https://www.npmjs.com/package/ejs
[default template]: ./src/default-template.ejs

## Templates

PR title and body templates are [EJS]. The following variables are available:

```typescript
interface TemplateVars {
  pr: {
    title: string; // value of the `pr-title` input
    label?: string; // value of the `pr-label` input
    draft: boolean; // value of the `pr-draft` input
    modifiable: boolean; // value of the `pr-modifiable` input

    template?: string; // value of the `pr-template` input
    templateFile?: string; // value of the `pr-template-file` input

    mergeStrategy: string; // value of the `pr-merge-strategy` input
    releaseNotes: boolean; // value of the `pr-release-notes` input
  };
  crate: {
    name: string; // the name of the crate being released
    path: string; // the full/absolute path to the crate
  };
  version: {
    previous: string; // the version of the crate prior to any changes
    actual: string; // the version of the crate after being released
    desired: string; // the value of the `version` input
  };
  branchName: string; // the name of the branch used for the PR
  title?: string; // the rendered title of the PR
                  // this is only available to the PR body template
}
```

## Outputs

The action sets the following:

- `pr-branch` (String) The name of the branch used for the PR
- `pr-url` (String) The URL to the newly-created PR
- `version` (String) The version of the crate after release

## Pairs well with

- [`taiki-e/install-action`](https://github.com/marketplace/actions/install-development-tools)
  install tooling (such as `cargo-release`) from binaries

- [`chainguard-dev/actions/setup-gitsign`](https://github.com/chainguard-dev/actions/tree/main/setup-gitsign)
  enable commit signatures in actions with [gitsign](https://github.com/sigstore/gitsign)

- [`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-check)
  check semver compatibility before publishing a release
