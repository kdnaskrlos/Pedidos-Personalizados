#!/usr/bin/env bash
# Ejecutar en Cloud Shell después de aprobar el commit del PR #12.
set -Eeuo pipefail
head=${1:?Indica el SHA aprobado del PR #12}
[[ "$head" =~ ^[a-f0-9]{40}$ ]] || { echo "SHA de aprobación inválido." >&2; exit 1; }
if [[ $(node -p 'process.versions.node.split(".")[0]') != 22 ]]; then
  exec npm exec --yes --package=node@22 -- bash "$0" "$head"
fi

project=pedidos-personalizados-6610e
repo=kdnaskrlos/Pedidos-Personalizados
base=546179b25a4f28a31e6e79029225d44ef09a9e74
work=$(mktemp -d "$PWD/pedidos-v3705.XXXXXX")
stage="verificar cuenta, PR y CI"
trap 'printf "\nDetenido en %s\nRespaldo y registros: %s\n" "$stage" "$work" >&2' ERR
die() { printf '%s\n' "$*" >&2; return 1; }

gh api user --jq .login >/dev/null
gcloud auth application-default print-access-token >/dev/null
[[ $(gcloud projects describe "$project" --format='value(projectNumber)') == 677258952289 ]] ||
  die "El proyecto Firebase no coincide."
check_pr() {
  gh pr view 12 --repo "$repo" --json state,isDraft,headRefOid,baseRefName |
    jq -ec --arg head "$head" 'select(.state == "OPEN" and .headRefOid == $head and .baseRefName == "main")'
}
check_main() {
  [[ $(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha) == "$base" ]] ||
    die "main cambió desde la revisión."
}
check_pr >/dev/null
check_main
gh api "repos/$repo/actions/workflows/pr-emuladores.yml/runs?head_sha=$head&event=pull_request&status=success" |
  jq -e --arg head "$head" 'any(.workflow_runs[]; .head_sha == $head and .conclusion == "success")' >/dev/null ||
  die "Falta CI en verde para el commit aprobado."
pages=$(gh api "repos/$repo/pages" |
  jq -er 'select(.build_type == "legacy" and .source.branch == "main" and .source.path == "/") | .html_url')
merge_flag=$(gh api "repos/$repo" | jq -er '
  select(.permissions.push == true) |
  if .allow_squash_merge then "--squash" elif .allow_merge_commit then "--merge"
  elif .allow_rebase_merge then "--rebase" else empty end')

stage="obtener el commit y respaldar Firestore"
git init -q "$work/src"
cd "$work/src"
git remote add origin "https://github.com/$repo.git"
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main refs/pull/12/head:refs/deploy/pr-12
[[ $(git rev-parse --verify 'refs/deploy/pr-12^{commit}') == "$head" ]]
[[ $(git rev-parse --verify 'refs/remotes/origin/main^{commit}') == "$base" ]]
git merge-base --is-ancestor "$base" "$head"
git checkout -q --detach refs/deploy/pr-12
npm ci --no-audit --no-fund
fb() {
  CI=true NO_COLOR=1 XDG_CONFIG_HOME="$work/firebase-cli" \
    ./node_modules/.bin/firebase "$@" --project "$project" --non-interactive
}
rules_api() {
  curl -fsS --max-time 30 -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
    "https://firebaserules.googleapis.com/v1/$1"
}
rules_active() {
  local release
  release=$(rules_api "projects/$project/releases/cloud.firestore" | jq -er .rulesetName)
  rules_api "$release" | jq -jer '.source.files | select(length == 1) | .[0].content'
}
same_rules() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [a,b] = process.argv.slice(2).map(path => fs.readFileSync(path));
const [s,l] = a.length <= b.length ? [a,b] : [b,a];
process.exitCode = a.equals(b) ||
  (l.length === s.length + 1 && l.at(-1) === 10 && s.at(-1) !== 10 && l.subarray(0,-1).equals(s)) ? 0 : 1;
NODE
}
index_snapshot() {
  fb firestore:indexes --database='(default)' --json |
    jq -e '.result | select((.indexes | type) == "array" and (.fieldOverrides | type) == "array")'
}
rules_active > "$work/firestore-anterior.rules"
index_snapshot > "$work/firestore-indices-anteriores.json"
git show "$base:firestore.rules" > "$work/firestore-base.rules"
same_rules "$work/firestore-base.rules" "$work/firestore-anterior.rules" ||
  die "Las reglas activas difieren de la base aprobada. Revisa el respaldo."
printf 'Respaldo previo a los cambios: %s\n' "$work"

# Respeta las configuraciones ajenas a este cambio, incluida cualquier política TTL.
jq -e 'all(.fieldOverrides[];
  if .fieldPath == "items" and (.collectionGroup == "pedidos" or .collectionGroup == "validacionesPago")
  then (.ttl != true and .indexes == []) else true end)' "$work/firestore-indices-anteriores.json" >/dev/null ||
  die "Ya existe una configuración de items diferente de la aprobada."

stage="desplegar y verificar reglas e índices de Firestore"
# Sin --force para conservar índices y exenciones ajenos al PR.
fb deploy --only firestore:indexes
indexes_ok=false
for attempt in $(seq 1 12); do
  if index_snapshot > "$work/firestore-indices-publicados.json" &&
     jq -e '
       . as $db | all(["pedidos","validacionesPago"][];
         . as $grupo | any($db.fieldOverrides[];
           .collectionGroup == $grupo and .fieldPath == "items" and .indexes == [] and .ttl != true))
     ' "$work/firestore-indices-publicados.json" >/dev/null &&
     jq -en --slurpfile antes "$work/firestore-indices-anteriores.json" \
       --slurpfile despues "$work/firestore-indices-publicados.json" \
       '($antes[0].indexes - $despues[0].indexes | length) == 0 and
        ($antes[0].fieldOverrides - $despues[0].fieldOverrides | length) == 0' >/dev/null &&
     gcloud firestore indexes composite list --project="$project" --database='(default)' --format=json |
       jq -e 'any(.[]; (.name | contains("/collectionGroups/pedidos/indexes/")) and
         .state == "READY" and .queryScope == "COLLECTION" and
         any(.fields[]; .fieldPath == "tipo" and .order == "ASCENDING") and
         any(.fields[]; .fieldPath == "lectores" and .arrayConfig == "CONTAINS"))' >/dev/null; then
    indexes_ok=true
    break
  fi
  sleep 5
done
[[ "$indexes_ok" == true ]] || die "Las exenciones o los índices previos no quedaron verificados."
fb deploy --only firestore:rules
rules_active > "$work/firestore-publicado.rules"
same_rules firestore.rules "$work/firestore-publicado.rules" ||
  die "Las reglas publicadas difieren del commit aprobado."

stage="fusionar el PR y verificar Pages"
check_main
if [[ $(check_pr | jq -r .isDraft) == true ]]; then gh pr ready 12 --repo "$repo"; fi
gh pr merge 12 --repo "$repo" "$merge_flag" --match-head-commit "$head"

pages=${pages%/}
for attempt in $(seq 1 36); do
  if [[ $(gh pr view 12 --repo "$repo" --json state --jq .state) == MERGED ]] &&
     curl -fsS --max-time 15 "$pages/?v=$head" -o "$work/pages-index.html" &&
     curl -fsS --max-time 15 "$pages/pedidos-sync.mjs?v=$head" -o "$work/pages-pedidos-sync.mjs" &&
     curl -fsS --max-time 15 "$pages/sw.js?v=$head" -o "$work/pages-sw.js" &&
     cmp -s index.html "$work/pages-index.html" &&
     cmp -s pedidos-sync.mjs "$work/pages-pedidos-sync.mjs" &&
     cmp -s sw.js "$work/pages-sw.js"; then
    printf 'Publicación v3.70.5 verificada en %s\nRespaldo y registros: %s\n' "$pages" "$work"
    exit 0
  fi
  sleep 10
done
die "Pages aún no sirve el commit aprobado. Revisa el despliegue y conserva el respaldo."
