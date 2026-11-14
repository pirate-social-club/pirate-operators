import { createHash } from 'node:crypto';
const quote = JSON.stringify;
/** Native capnp fields are bound to workerd v1.20261110.1, not inferred from Wrangler. */
export function renderConfig(manifest, mode, migrationPlan, assetIndex) {
  if (!['initialize', 'serve'].includes(mode) || !manifest.identity.qualificationOnly)
    throw new Error('Only the reviewed foundation modes are admitted');
  const profile = manifest.identity.profile;
  const scope = createHash('sha256').update(JSON.stringify({
    origin: profile.origin, communityId: profile.directoryProfile.communityId,
  })).digest('hex');
  const disk = (name, path) => `(name=${quote(name)}, disk=(path=${quote(path)},writable=true,allowDotfiles=true))`;
  const backend = (name, module, cls, key, storage, extra = '') => `(name=${quote(name)},worker=(
    modules=[(name=${quote(module)},esModule=embed ${quote('/opt/pirate/release/' + module)})],
    compatibilityDate="2023-07-24",compatibilityFlags=["nodejs_compat","experimental"],
    durableObjectNamespaces=[(className=${quote(cls)},uniqueKey=${quote(key)},enableSql=true)],
    durableObjectStorage=(localDisk=${quote(storage)}),globalOutbound="deny-egress"${extra}))`;
  const entry = (name, target, cls, namespace) => `(name=${quote(name)},worker=(
    modules=[(name="object-entry.worker.js",esModule=embed "/opt/pirate/release/object-entry.worker.js")],
    compatibilityDate="2023-07-24",bindings=[(name="MINIFLARE_NAMESPACE",text=${quote(namespace)}),
    (name="MINIFLARE_OBJECT",durableObjectNamespace=(serviceName=${quote(target)},className=${quote(cls)}))],
    globalOutbound="deny-egress"))`;
  const db = '(name="DB",wrapped=(moduleName="cloudflare-internal:d1-api",innerBindings=[(name="fetcher",service="d1-entry")]))';
  const media = '(name="MEDIA",r2Bucket="media-entry")';
  const services = [
    entry('d1-entry', 'd1-backend', 'D1DatabaseObject', 'community-' + scope),
    backend('d1-backend', 'database.worker.js', 'D1DatabaseObject', 'pirate-linux-d1-v1-' + scope, 'd1-storage'),
    entry('media-entry', 'media-backend', 'R2BucketObject', 'media-' + scope),
    backend('media-backend', 'bucket.worker.js', 'R2BucketObject', 'pirate-linux-r2-v1-' + scope,
      'media-storage', ',bindings=[(name="MINIFLARE_BLOBS",service="media-storage")]'),
    disk('d1-storage', '/var/lib/pirate/d1'), disk('media-storage', '/var/lib/pirate/media'),
    `(name="deny-egress",worker=(modules=[(name="deny.mjs",esModule=${quote('export default {fetch(){return new Response("external_dependency_unavailable",{status:503})}}')})],compatibilityDate="2026-11-04"))`,
  ];
  let socket;
  if (mode === 'initialize') {
    services.push(`(name="maintenance",worker=(modules=[(name="maintenance.mjs",esModule=embed "/opt/pirate/runtime/maintenance.worker.mjs")],
      compatibilityDate="2026-11-04",bindings=[${db},${media},(name="MIGRATION_PLAN_JSON",text=${quote(migrationPlan)})],globalOutbound="deny-egress"))`);
    socket = '(name="initialize",address="unix:/tmp/pirate/initialize.sock",http=(),service="maintenance")';
  } else {
    services.push('(name="asset-files",disk=(path="/opt/pirate/release/assets",writable=false))');
    services.push(`(name="assets",worker=(modules=[(name="assets.mjs",esModule=embed "/opt/pirate/runtime/assets.worker.mjs")],
      compatibilityDate="2026-11-04",bindings=[(name="FILES",service="asset-files"),(name="ASSET_INDEX_JSON",text=${quote(assetIndex)})],globalOutbound="deny-egress"))`);
    services.push(`(name="application",worker=(modules=[(name="application.mjs",esModule=embed "/opt/pirate/release/application.mjs")],
      compatibilityDate="2026-11-04",compatibilityFlags=["nodejs_compat","global_fetch_strictly_public"],bindings=[${db},${media},
      (name="ASSETS",service="assets"),(name="COMMUNITY_DEPLOYMENT_PROFILE_JSON",text=${quote(JSON.stringify(profile))}),
      (name="COMMUNITY_NAME",text=${quote(profile.name)}),(name="PLAN_ID",text=${quote(profile.planId)}),
      (name="APPLICATION_PROFILE_HASH",text=${quote('0x' + manifest.releaseId)})],globalOutbound="deny-egress"))`);
    socket = '(name="https",address="*:8443",https=(options=(),tlsOptions=(keypair=(privateKey=embed "/run/pirate/tls/leaf.key",certificateChain=embed "/run/pirate/tls/leaf.crt"))),service="application")';
  }
  return `using Workerd=import "/workerd/workerd.capnp";
const config :Workerd.Config=(extensions=[(modules=[
  (name="miniflare:shared",esModule=embed "/opt/pirate/release/shared.worker.js"),
  (name="miniflare:zod",esModule=embed "/opt/pirate/release/zod.worker.js")])],
services=[${services.join(',\n')}],sockets=[${socket}]);\n`;
}
