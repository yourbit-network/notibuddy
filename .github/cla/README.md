# Contributor assignment bot setup

The agreement is an adaptation of **Harmony CAA 1.0**, with copyright assignment to **Yourbit, LLC**, outbound **Option Five**, and **Delaware** governing law. It retains Harmony's license back to contributors and patent license. It does not assign every category of intellectual property, waive non-waivable rights, or transfer rights belonging to other people. The public software remains MIT-licensed.

Use the maintained, hosted [CLA Assistant](https://cla-assistant.io/) to collect signatures and report PR status. Its [source and setup documentation](https://github.com/cla-assistant/cla-assistant) describe Gist-backed agreements, custom signing fields, versioned signatures, and exports. The separate `contributor-assistant/github-action` repository was archived on March 23, 2026; this setup does not depend on it or add a privileged `pull_request_target` workflow.

**Activation status:** repository files alone do not activate the hosted bot or a required merge check. An administrator must connect the Gist and repository, then require the resulting status check. Do not describe the integration as enforced until the verification below passes.

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
5. Open a real PR and confirm that CLA Assistant posts its signing link and a failing status for an unsigned contributor. Inspect the form: legal name, email, capacity, rights holder, title, authority and explicit assent must all be present and required. The person must sign for themselves; never click acceptance on someone else's behalf to test it.
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
