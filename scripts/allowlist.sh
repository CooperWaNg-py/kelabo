#!/usr/bin/env bash
# Manage an environment's `allowIps` — the source addresses that may reach the
# deployment at all (docs 07).
#
# Usage: scripts/allowlist.sh <env> list
#        scripts/allowlist.sh <env> add <cidr|this>
#        scripts/allowlist.sh <env> rm  <cidr>
#
# Two things hold the list, and both are written here so they cannot drift:
#
#   config/kelabo.json   the source of truth. CDK reads it, so a deploy always
#                        re-asserts exactly this.
#   AWS                  the WAF IPSets (CloudFront) and the ALB security group
#                        (Gateway), edited live so an address works in seconds
#                        rather than after a CloudFormation update.
#
# The live edit is skipped, with a message, when the environment is not locked
# yet: going from an open deployment to a locked one adds a stack and removes
# the ALB's 0.0.0.0/0 rule, and neither is something a security-group call can
# do. That first transition needs a deploy; every addition after it does not.
set -euo pipefail

ENV="${1:?usage: allowlist.sh <env> <list|add|rm> [cidr]}"
CMD="${2:?usage: allowlist.sh <env> <list|add|rm> [cidr]}"
ARG="${3:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/config/kelabo.json"

read -r APP ENDPOINT REGION LOCKED <<EOF
$(cd "$ROOT/config" && KELABO_ENV="$ENV" node --input-type=module -e "
import('./loadConfig.mjs').then((m) => {
  const c = m.loadConfig(process.env.KELABO_ENV);
  console.log([c.app, c.endpoint, c.region, c.allowIps.length ? 'locked' : 'open'].join(' '));
}).catch((e) => { console.error(e.message); process.exit(1); });
")
EOF

PREFIX="$APP-$ENDPOINT"

# --- reading the config list -------------------------------------------------

config_list() {
  node -e "
    const c = require('$CONFIG');
    console.log((c.environments['$ENV'].allowIps || []).join('\n'));
  "
}

# Writes the list back, preserving the rest of the file. node rather than jq:
# jq is not a dependency of anything else here, and a missing one would fail
# halfway through a change.
config_write() {
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    // filter(Boolean): an empty bash array expands to one empty argument, and
    // writing [\"\"] would put an address that matches nothing into the list.
    c.environments['$ENV'].allowIps = process.argv.slice(1).filter(Boolean);
    fs.writeFileSync('$CONFIG', JSON.stringify(c, null, 2) + '\n');
  " "$@"
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$2" \
    --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text 2>/dev/null || true
}

# --- what AWS currently holds ------------------------------------------------

live_ipset() { # <name> <id> -> addresses, one per line
  aws wafv2 get-ip-set --name "$1" --id "$2" --scope CLOUDFRONT --region us-east-1 \
    --query 'IPSet.Addresses[]' --output text 2>/dev/null | tr '\t' '\n' || true
}

live_sg_cidrs() { # <sg-id> -> cidrs allowed on 443, one per line
  aws ec2 describe-security-groups --group-ids "$1" --region "$REGION" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`443`].[IpRanges[].CidrIp,Ipv6Ranges[].CidrIpv6]' \
    --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' || true
}

# --- applying live -----------------------------------------------------------

apply_live() {
  local v4=() v6=() cidr
  while read -r cidr; do
    [ -z "$cidr" ] && continue
    case "$cidr" in *:*) v6+=("$cidr");; *) v4+=("$cidr");; esac
  done < <(config_list)

  local sg
  sg="$(stack_output "$PREFIX-gateway" "$REGION" GatewayAlbSecurityGroupId)"
  local v4id v4name v6id v6name
  v4id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Id)"
  v4name="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Name)"
  v6id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Id)"
  v6name="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Name)"

  if [ -z "$v4id" ] || [ -z "$sg" ]; then
    echo
    echo "  Config updated, AWS not touched: $ENV is not locked yet."
    echo "  Locking adds the WAF stack and removes the ALB's 0.0.0.0/0 rule,"
    echo "  which only a deploy can do:  make deploy env=$ENV"
    return 0
  fi

  update_ipset "$v4name" "$v4id" "${v4[@]:-}"
  update_ipset "$v6name" "$v6id" "${v6[@]:-}"
  sync_sg "$sg" "${v4[@]:-}" -- "${v6[@]:-}"
  echo "  Live: WAF IPSets and security group $sg now match the config."
}

update_ipset() { # <name> <id> <cidr...>
  local name="$1" id="$2"; shift 2
  local token
  token="$(aws wafv2 get-ip-set --name "$name" --id "$id" --scope CLOUDFRONT \
    --region us-east-1 --query LockToken --output text)"
  # As JSON rather than shell words, because one family is routinely empty (an
  # IPv4-only network has nothing to put in the v6 set) and `--addresses` with
  # no values is a CLI error, not an empty list.
  local addrs
  addrs="$(printf '%s\n' "$@" | node -e "
    let d = '';
    process.stdin.on('data', (c) => (d += c))
      .on('end', () => console.log(JSON.stringify(d.split('\n').map(s => s.trim()).filter(Boolean))));
  ")"
  # A lock token is a compare-and-swap: if anything else changed the set since
  # the read, this call is rejected rather than silently clobbering it.
  aws wafv2 update-ip-set --name "$name" --id "$id" --scope CLOUDFRONT \
    --region us-east-1 --lock-token "$token" --addresses "$addrs" >/dev/null
}

sync_sg() { # <sg-id> <v4...> -- <v6...>
  local sg="$1"; shift
  local v4=() v6=() seen_sep=0
  for a in "$@"; do
    if [ "$a" = "--" ]; then seen_sep=1; continue; fi
    [ -z "$a" ] && continue
    if [ "$seen_sep" = 1 ]; then v6+=("$a"); else v4+=("$a"); fi
  done

  # Add what is missing. Revoking what is extra is left to `rm`, which knows
  # which address the operator meant — a blind diff here would drop a rule
  # someone added by hand during an incident.
  local existing; existing="$(live_sg_cidrs "$sg")"
  for cidr in "${v4[@]:-}"; do
    [ -z "$cidr" ] && continue
    echo "$existing" | grep -qxF "$cidr" && continue
    authorize "$sg" "IpRanges=[{CidrIp=$cidr,Description='allowIps'}]"
  done
  for cidr in "${v6[@]:-}"; do
    [ -z "$cidr" ] && continue
    echo "$existing" | grep -qxF "$cidr" && continue
    authorize "$sg" "Ipv6Ranges=[{CidrIpv6=$cidr,Description='allowIps'}]"
  done
}

authorize() { # <sg-id> <range-spec>
  local sg="$1" ranges="$2" port
  for port in 443 80; do
    aws ec2 authorize-security-group-ingress --group-id "$sg" --region "$REGION" \
      --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,$ranges" \
      >/dev/null 2>&1 || true
  done
}

revoke_live() { # <cidr>
  local cidr="$1" sg port ranges
  sg="$(stack_output "$PREFIX-gateway" "$REGION" GatewayAlbSecurityGroupId)"
  [ -z "$sg" ] && return 0
  case "$cidr" in
    *:*) ranges="Ipv6Ranges=[{CidrIpv6=$cidr}]";;
    *)   ranges="IpRanges=[{CidrIp=$cidr}]";;
  esac
  for port in 443 80; do
    aws ec2 revoke-security-group-ingress --group-id "$sg" --region "$REGION" \
      --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,$ranges" \
      >/dev/null 2>&1 || true
  done
}

# --- this device's public addresses ------------------------------------------

this_device() {
  local v4 v6
  # checkip is AWS's own, so this adds no third party to a security control.
  v4="$(curl -4 -s --max-time 8 https://checkip.amazonaws.com || true)"
  v6="$(curl -6 -s --max-time 8 https://checkip.amazonaws.com || true)"
  [ -n "$v4" ] && echo "${v4//[$'\r\n ']/}/32"
  # Absent on an IPv4-only network, which is normal and not an error. It is
  # still worth adding when present: CloudFront answers on IPv6, so a browser
  # that prefers it arrives from an address the IPv4 entry does not cover.
  [ -n "$v6" ] && echo "${v6//[$'\r\n ']/}/128"
}

# --- commands ----------------------------------------------------------------

case "$CMD" in
  list)
    echo
    echo "  $PREFIX — $LOCKED"
    echo
    echo "  config/kelabo.json:"
    config_list | sed 's/^/    /' | grep -v '^ *$' || echo "    (empty — open to everyone)"
    v4id="$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Id)"
    if [ -n "$v4id" ]; then
      echo
      echo "  live (CloudFront WAF):"
      { live_ipset "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV4Name)" "$v4id"
        live_ipset "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Name)" \
                   "$(stack_output "$PREFIX-waf" us-east-1 AllowIpSetV6Id)"; } \
        | grep -v '^$' | sed 's/^/    /' || echo "    (none)"
      sg="$(stack_output "$PREFIX-gateway" "$REGION" GatewayAlbSecurityGroupId)"
      echo
      echo "  live (Gateway ALB security group $sg):"
      live_sg_cidrs "$sg" | grep -v '^$' | sed 's/^/    /' || echo "    (none)"
    else
      echo
      echo "  live: no WAF stack — this environment is open."
    fi
    echo
    echo "  this device: $(this_device | tr '\n' ' ')"
    echo
    ;;

  add)
    [ -n "$ARG" ] || { echo "usage: allowlist.sh $ENV add <cidr|this>" >&2; exit 1; }
    if [ "$ARG" = "this" ]; then mapfile -t adding < <(this_device); else adding=("$ARG"); fi
    mapfile -t current < <(config_list | grep -v '^$' || true)
    for cidr in "${adding[@]}"; do
      if printf '%s\n' "${current[@]:-}" | grep -qxF "$cidr"; then
        echo "  already listed: $cidr"
      else
        current+=("$cidr")
        echo "  added: $cidr"
      fi
    done
    config_write "${current[@]}"
    apply_live
    ;;

  rm)
    [ -n "$ARG" ] || { echo "usage: allowlist.sh $ENV rm <cidr>" >&2; exit 1; }
    mapfile -t current < <(config_list | grep -v '^$' | grep -vxF "$ARG" || true)
    config_write "${current[@]:-}"
    echo "  removed: $ARG"
    if [ "${#current[@]}" -eq 0 ]; then
      echo
      echo "  The list is now empty, which means OPEN TO EVERYONE — and that"
      echo "  takes a deploy, because the WAF stack and the ALB's 0.0.0.0/0"
      echo "  rule are CDK's:  make deploy env=$ENV"
    else
      apply_live
      revoke_live "$ARG"
    fi
    ;;

  *)
    echo "usage: allowlist.sh <env> <list|add|rm> [cidr]" >&2
    exit 1
    ;;
esac
