# Cloudflare Pages R2 Binding Troubleshooting

This guide fixes deployments that fail after assets upload with:

```text
Error: Failed to publish your Function. Got error: binding R2_BUCKET of type r2_bucket contains an invalid jurisdiction
```

The failure happens before K-Vault code runs. Cloudflare Pages is validating the `R2_BUCKET` binding metadata and rejects a bad `jurisdiction` value.

## Fast Fix

1. Open `Workers & Pages` -> your Pages project -> `Settings` -> `Bindings`.
2. Check both `Production` and `Preview`.
3. Delete the `R2_BUCKET` binding in every environment where it exists.
4. Go to `R2 Object Storage` and create or select a bucket named `k-vault-files`.
5. If you do not need data residency restrictions, create the bucket with automatic placement. Do not choose a jurisdiction.
6. Add the Pages binding again:
   - Type: `R2 bucket`
   - Variable name: `R2_BUCKET`
   - Bucket: `k-vault-files`
7. Redeploy the Pages project.

Do not enter `auto`, `default`, `wnam`, `apac`, or other location hints as a jurisdiction. R2 only accepts `eu` or `fedramp` as jurisdiction values. Normal buckets should omit `jurisdiction` completely.

## If The Dashboard Binding Keeps Failing

Use a Wrangler configuration file as the source of truth for the binding. Generate a clean config from this repository:

```bash
KV_NAMESPACE_ID=<your_img_url_namespace_id> \
R2_BUCKET_NAME=k-vault-files \
npm run pages:r2:doctor -- --write
```

For an EU jurisdiction bucket:

```bash
KV_NAMESPACE_ID=<your_img_url_namespace_id> \
R2_BUCKET_NAME=k-vault-files \
R2_BUCKET_JURISDICTION=eu \
npm run pages:r2:doctor -- --write
```

Then inspect the generated `wrangler.jsonc` and redeploy from Cloudflare Pages.

Important: once `wrangler.jsonc` is present, Cloudflare Pages treats the file as the source of truth for those Pages settings. Keep the `img_url` KV binding and `R2_BUCKET` binding in the file. If your Preview environment uses different resources, add `env.preview` overrides before deploying preview builds.

You can validate an existing config locally:

```bash
npm run pages:r2:doctor -- --check
```

## S3-Compatible Fallback

If you cannot repair the native Pages R2 binding, remove the `R2_BUCKET` binding and use K-Vault's S3-compatible storage mode with Cloudflare R2 credentials:

| Variable | Value |
| :--- | :--- |
| `S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_BUCKET` | `k-vault-files` |
| `S3_ACCESS_KEY_ID` | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` | R2 API token secret |

For jurisdictional R2 buckets, use a jurisdiction endpoint such as `https://<account_id>.eu.r2.cloudflarestorage.com`.

This fallback avoids the Pages native `R2_BUCKET` binding entirely, so the deployment cannot fail on the Pages binding jurisdiction check.
