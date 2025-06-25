#!/bin/bash
# 🔍 Cloudflare Search Service - Monitoring Deployment Script
# This script automates the complete monitoring setup

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="${SCRIPT_DIR}/terraform"

# Functions
log_info() {
  echo -e "${BLUE}ℹ️  INFO: $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ SUCCESS: $1${NC}"
}

log_warning() {
  echo -e "${YELLOW}⚠️  WARNING: $1${NC}"
}

log_error() {
  echo -e "${RED}❌ ERROR: $1${NC}"
}

check_dependencies() {
  log_info "Checking dependencies..."

  # Check for required tools
  local deps=("curl" "jq" "terraform")
  for dep in "${deps[@]}"; do
    if ! command -v "$dep" &>/dev/null; then
      log_error "$dep is required but not installed"
      exit 1
    fi
  done

  # Check for required environment variables
  local env_vars=("CLOUDFLARE_API_TOKEN" "CLOUDFLARE_ZONE_ID" "DATADOG_API_KEY" "DATADOG_APP_KEY")
  for var in "${env_vars[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      log_error "Environment variable $var is required"
      exit 1
    fi
  done

  log_success "All dependencies checked"
}

configure_cloudflare_logpush() {
  log_info "Configuring Cloudflare Logpush to Datadog..."

  local logpush_config=$(
    cat <<EOF
{
    "name": "cf-search-datadog-logs",
    "destination_conf": "datadog://intake.logs.datadoghq.com:443?dd-api-key=${DATADOG_API_KEY}&service=cf-search&source=cloudflare",
    "dataset": "workers_trace_events",
    "enabled": true,
    "logpull_options": "fields=Event,EventTimestampMs,Outcome,ScriptName,ScriptTags,Logs,Exceptions,CPUTime,DurableObjectId,RequestHeaders,ResponseHeaders&timestamps=rfc3339"
}
EOF
  )

  local response=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/logpush/jobs" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$logpush_config")

  if echo "$response" | jq -e '.success' >/dev/null; then
    local job_id=$(echo "$response" | jq -r '.result.id')
    log_success "Cloudflare Logpush job created with ID: $job_id"
    echo "$job_id" >"${SCRIPT_DIR}/.logpush_job_id"
  else
    local error_msg=$(echo "$response" | jq -r '.errors[0].message // "Unknown error"')
    log_error "Failed to create Logpush job: $error_msg"
    exit 1
  fi
}

deploy_datadog_monitoring() {
  log_info "Deploying Datadog monitoring infrastructure..."

  cd "$TERRAFORM_DIR"

  # Initialize Terraform
  log_info "Initializing Terraform..."
  terraform init

  # Create terraform.tfvars if it doesn't exist
  if [[ ! -f "terraform.tfvars" ]]; then
    log_info "Creating terraform.tfvars..."
    cat >terraform.tfvars <<EOF
datadog_api_key = "${DATADOG_API_KEY}"
datadog_app_key = "${DATADOG_APP_KEY}"
environment = "${ENVIRONMENT:-production}"
alert_notification_targets = ["@slack-alerts", "@pagerduty"]
EOF
  fi

  # Plan and apply
  log_info "Planning Terraform deployment..."
  terraform plan -out=tfplan

  log_info "Applying Terraform configuration..."
  terraform apply tfplan

  # Save outputs
  terraform output -json >"${SCRIPT_DIR}/terraform-outputs.json"

  cd - >/dev/null
  log_success "Datadog monitoring infrastructure deployed"
}

validate_monitoring() {
  log_info "Validating monitoring setup..."

  # Check if logs are flowing
  log_info "Waiting for logs to start flowing (this may take a few minutes)..."
  sleep 60

  # Check Datadog for incoming logs
  local logs_check=$(curl -s -X POST \
    "https://api.datadoghq.com/api/v1/logs-queries/list" \
    -H "Content-Type: application/json" \
    -H "DD-API-KEY: ${DATADOG_API_KEY}" \
    -H "DD-APPLICATION-KEY: ${DATADOG_APP_KEY}" \
    -d '{
            "query": "service:cf-search",
            "time": {
                "from": "now-5m",
                "to": "now"
            },
            "limit": 1
        }')

  if echo "$logs_check" | jq -e '.logs | length > 0' >/dev/null; then
    log_success "Logs are flowing to Datadog"
  else
    log_warning "No logs detected yet. This is normal for a new setup."
    log_info "Logs may take 5-10 minutes to appear in Datadog"
  fi

  # Validate dashboard creation
  if [[ -f "${SCRIPT_DIR}/terraform-outputs.json" ]]; then
    local dashboard_url=$(jq -r '.dashboard_url.value // empty' "${SCRIPT_DIR}/terraform-outputs.json")
    if [[ -n "$dashboard_url" ]]; then
      log_success "Dashboard created: $dashboard_url"
    fi
  fi
}

generate_summary() {
  log_info "Generating deployment summary..."

  cat >"${SCRIPT_DIR}/deployment-summary.md" <<EOF
# 🔍 Monitoring Deployment Summary

## ✅ Completed Successfully

- **Cloudflare Logpush**: Configured to send logs to Datadog
- **Datadog Pipeline**: Log processing and parsing configured
- **Custom Metrics**: Created from log data
- **Dashboard**: Comprehensive monitoring dashboard
- **Alerts**: Critical production alerts configured
- **SLOs**: Service level objectives defined

## 📊 Access Information

EOF

  if [[ -f "${SCRIPT_DIR}/terraform-outputs.json" ]]; then
    local dashboard_url=$(jq -r '.dashboard_url.value // "Not available"' "${SCRIPT_DIR}/terraform-outputs.json")
    echo "- **Dashboard URL**: $dashboard_url" >>"${SCRIPT_DIR}/deployment-summary.md"

    echo "- **Monitor IDs**:" >>"${SCRIPT_DIR}/deployment-summary.md"
    jq -r '.monitor_ids.value | to_entries[] | "  - \(.key): \(.value)"' "${SCRIPT_DIR}/terraform-outputs.json" >>"${SCRIPT_DIR}/deployment-summary.md"

    echo "- **SLO IDs**:" >>"${SCRIPT_DIR}/deployment-summary.md"
    jq -r '.slo_ids.value | to_entries[] | "  - \(.key): \(.value)"' "${SCRIPT_DIR}/terraform-outputs.json" >>"${SCRIPT_DIR}/deployment-summary.md"
  fi

  cat >>"${SCRIPT_DIR}/deployment-summary.md" <<EOF

## 🔧 Next Steps

1. **Deploy Enhanced Search Service**: Deploy the updated search service with structured logging
2. **Test Alerts**: Trigger test alerts to verify notification channels
3. **Review Thresholds**: Adjust alert thresholds based on your specific requirements
4. **Team Training**: Share dashboard and runbook with your team

## 📚 Resources

- **Setup Guide**: monitoring/MONITORING_SETUP.md
- **Datadog Config**: monitoring/datadog-config.yml
- **Terraform Config**: monitoring/terraform/datadog.tf
- **Deployment Summary**: monitoring/deployment-summary.md

## 🚨 Important Notes

- Logs may take 5-10 minutes to appear in Datadog initially
- Adjust alert notification targets in terraform.tfvars as needed
- Review and customize dashboard widgets for your specific needs
- Test alert escalation paths before relying on them in production

Generated on: $(date)
EOF

  log_success "Deployment summary created: ${SCRIPT_DIR}/deployment-summary.md"
}

cleanup_on_failure() {
  log_error "Deployment failed. Cleaning up..."

  # Remove Cloudflare logpush job if created
  if [[ -f "${SCRIPT_DIR}/.logpush_job_id" ]]; then
    local job_id=$(cat "${SCRIPT_DIR}/.logpush_job_id")
    log_info "Removing Cloudflare Logpush job: $job_id"
    curl -s -X DELETE \
      "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/logpush/jobs/${job_id}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" >/dev/null
    rm -f "${SCRIPT_DIR}/.logpush_job_id"
  fi

  # Destroy Terraform resources
  if [[ -f "${TERRAFORM_DIR}/terraform.tfstate" ]]; then
    log_info "Destroying Terraform resources..."
    cd "$TERRAFORM_DIR"
    terraform destroy -auto-approve
    cd - >/dev/null
  fi
}

main() {
  echo "🔍 Cloudflare Search Service - Monitoring Setup"
  echo "============================================="
  echo

  # Set up error handling
  trap cleanup_on_failure ERR

  # Run deployment steps
  check_dependencies
  configure_cloudflare_logpush
  deploy_datadog_monitoring
  validate_monitoring
  generate_summary

  echo
  log_success "🎉 Monitoring deployment completed successfully!"
  echo
  echo "📊 Dashboard and alerts are now configured."
  echo "📄 Check deployment-summary.md for details."
  echo "📚 Review MONITORING_SETUP.md for advanced configuration."
  echo
}

# Help function
show_help() {
  cat <<EOF
🔍 Cloudflare Search Service - Monitoring Deployment

USAGE:
    $0 [OPTIONS]

REQUIRED ENVIRONMENT VARIABLES:
    CLOUDFLARE_API_TOKEN    Cloudflare API token with Zone:Read, Zone:Edit permissions
    CLOUDFLARE_ZONE_ID      Cloudflare Zone ID where your worker is deployed
    DATADOG_API_KEY         Datadog API key
    DATADOG_APP_KEY         Datadog Application key

OPTIONAL ENVIRONMENT VARIABLES:
    ENVIRONMENT             Environment name (default: production)

OPTIONS:
    -h, --help              Show this help message
    --validate-only         Only validate existing setup
    --destroy               Destroy monitoring infrastructure

EXAMPLES:
    # Deploy monitoring
    CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ZONE_ID=xxx DATADOG_API_KEY=xxx DATADOG_APP_KEY=xxx ./deploy-monitoring.sh
    
    # Validate existing setup
    ./deploy-monitoring.sh --validate-only
    
    # Destroy infrastructure
    ./deploy-monitoring.sh --destroy

EOF
}

# Parse command line arguments
case "${1:-}" in
-h | --help)
  show_help
  exit 0
  ;;
--validate-only)
  check_dependencies
  validate_monitoring
  exit 0
  ;;
--destroy)
  log_warning "This will destroy all monitoring infrastructure"
  read -p "Are you sure? (y/N): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cleanup_on_failure
    log_success "Monitoring infrastructure destroyed"
  fi
  exit 0
  ;;
"")
  main
  ;;
*)
  log_error "Unknown option: $1"
  show_help
  exit 1
  ;;
esac
