# Contributor assignment bot setup

The agreement is an adaptation of **Harmony CAA 1.0**, with copyright assignment to **Yourbit, LLC**, outbound **Option Five**, and **Delaware** governing law. It retains Harmony's license back to contributors and patent license. It does not assign every category of intellectual property, waive non-waivable rights, or transfer rights belonging to other people. The public software remains MIT-licensed.

Use the maintained, hosted [CLA Assistant](https://cla-assistant.io/) to collect signatures and report PR status. Its [source and setup documentation](https://github.com/cla-assistant/cla-assistant) describe Gist-backed agreements, custom signing fields, versioned signatures, and exports. The separate `contributor-assistant/github-action` repository was archived on March 23, 2026; this setup does not depend on it or add a privileged `pull_request_target` workflow.

**Activation status:** the hosted CLA Assistant integration and required merge check are active for `yourbit-network/notibuddy` as of October 15, 2026. The `Protect main` ruleset requires `license/cla` alongside the existing GitHub Actions `Required checks`, with branches required to be up to date. Its existing pull-request, deletion, force-push, and bypass settings were preserved.

## Published agreement

- Company-owned [agreement Gist](https://gist.github.com/yourbit-network/df6451ac687a25b1ae4a0c541f22807b).
- Initial immutable revision: `036d26504dc85d2307e06cf460e478e9cc4256d0`.
- `CLA.md` SHA-256: `f7f26a323f5f4287267514416618a1358d3bcc0c8be28b22e9f9209c1852fc7d`.
- Gist `metadata` SHA-256: `202f210d46c86bbaf901a360689e2ac34832cf5646052613e9daa91c10b27235`.
- Both published files were verified byte-for-byte against the reviewed repository sources.
- Only this repository is linked. Gist sharing is disabled and no minimum contribution-size exemption is configured.
- [Contributor signing page](https://cla-assistant.io/yourbit-network/notibuddy).

## Activation verification

- CLA Assistant created the repository webhook and posted its signing comment and `license/cla` status on [PR #13](https://github.com/yourbit-network/notibuddy/pull/13).
- With the contributor unsigned, the status is **pending**, with the description `Contributor License Agreement is not signed yet.` It is not a failing check; requiring it prevents merging until it succeeds.
- At commit `e54c780c517dfd49d10fb85b48ef9d0df2cf1c57`, all seven CI checks passed while `license/cla` remained pending and GitHub reported the PR merge state as `BLOCKED`.
- The [active ruleset](https://github.com/yourbit-network/notibuddy/settings/rules/24690450) was verified through GitHub's branch-rules API. The only rule change was adding `license/cla`; the existing `Required checks` remains bound to GitHub Actions (integration ID `15368`). GitHub offers no dedicated expected source for this hosted OAuth integration, so `license/cla` uses `Any source`. Write access must remain limited to trusted maintainers who can report commit statuses.
- No signatures were imported, no human exemption was added, and no contributor was signed automatically. A legitimately signed contributor passing, a subsequent unsigned co-author blocking, and fork-PR behavior still require onboarding verification; they have not been claimed as tested.

## Activate once

1. Have counsel review `CLA.md`, the capacity selection and electronic signature process. This is an adapted template, not an opinion that every provision is enforceable for every contributor.
2. Merge the reviewed agreement and contribution instructions. Prepare the two Gist files from this checkout:

   ```sh
   node scripts/prepare-cla-gist.mjs /tmp/notibuddy-cla-gist.json
   ```

   The script writes a GitHub Gist creation payload containing **`CLA.md`** and a file named exactly **`metadata`**. The latter must contain the JSON from `metadata.json`; its Gist filename must not be `metadata.json`. Review the payload before publishing it.
3. While authenticated as the company-controlled GitHub account, create a **public** Gist with those two files. The document and field definitions are public; never put completed contributor forms or signature exports in the Gist. With an already-authorized owner CLI session, the equivalent command is:

   ```sh
   gh api --method POST gists --input /tmp/notibuddy-cla-gist.json --jq .html_url
   ```

4. Sign in to CLA Assistant as an administrator of `yourbit-network/notibuddy`. Review its terms and requested GitHub access. Link **only this repository** to the new Gist. Do not enable organization-wide signature sharing: the agreement is scoped to this project. Do not import existing contributors as signed without an actual executed agreement. Do not add wildcard or human exemptions.
5. Open a real PR and confirm that CLA Assistant posts its signing link and a non-success status for an unsigned contributor (the hosted service currently uses `pending`). Inspect the form: legal name, email, capacity, rights holder, title, authority and explicit assent must all be present and required. The person must sign for themselves; never click acceptance on someone else's behalf to test it.
6. In the `main` branch protection/ruleset, add the **actual status context emitted by CLA Assistant** as a required check alongside `Required checks`. Preserve existing review, signed-commit, secret-scan and platform requirements. Select the expected status source where GitHub supports it. A comment, badge, optional workflow, or green package CI is not merge enforcement.
7. Confirm an unsigned PR cannot merge, a legitimately signed contributor passes, and adding a new unsigned author makes the PR fail. Check a fork PR as well. Record the Gist URL, revision, check context and successful validation in this file once the integration is live.

The GitHub account authorized for the service must retain repository administration access. Verify webhook health and service status if a PR has no CLA result; do not bypass the required check to work around an outage.

## Review responsibilities and exceptions

- Review the actual authors and co-authors, including those whose commit email is not linked to GitHub. Do not assume the bot proves authorship, legal capacity, employer authorization, or complete coverage of unusual/large commit histories.
- Require an independently executed Entity agreement and recorded employee/account scope where needed. One authorized representative's green check is not proof that every employee is covered. Keep those records private.
- Dependency bots cannot make legal assignments. Review mechanical dependency updates and preserve upstream licenses. If an exemption is justified, configure only the exact bot identity (for example `dependabot[bot]`), document its limited purpose, and review every change; never treat a bot exemption as an assignment of third-party dependencies. No bot exemption is preconfigured here.
- Existing unsigned contributions are not transferred merely by adding this agreement. Obtain actual acceptance or a separate assignment where needed. Do not fabricate or backfill acceptance records.
- Review imported third-party code separately. An assignment from the PR author cannot remove another owner's license conditions or transfer rights they do not own.

## Changes and records

Keep `CLA.md` and `metadata.json` reviewed in Git. To revise the agreement, update the existing Gist to the exact reviewed document and metadata together. CLA Assistant tracks Gist revisions and requests new acceptance when its agreement changes. Verify that behavior with the updated version before accepting new contributions; never overwrite an old acceptance record to pretend it covers new terms.

Export signatures from the CLA Assistant dashboard after onboarding and periodically thereafter. Store exports, the corresponding immutable Gist revision, and entity authorization evidence in restricted company storage. Do not commit completed signing details to this public repository or rely on expiring CI artifacts as the only record.

The form collects legal names and contact emails privately through CLA Assistant. Review its privacy terms and Yourbit's retention/access practices before enabling collection. The bot records acceptance; it does not give a legal guarantee about an assignment's validity.
