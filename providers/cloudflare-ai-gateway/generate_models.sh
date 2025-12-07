#!/bin/bash
#
# Generate model TOML files for Cloudflare AI Gateway
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN  - Your Cloudflare API token
#   CLOUDFLARE_ACCOUNT_ID - Your Cloudflare account ID
#   CLOUDFLARE_GATEWAY_ID - Your AI Gateway name/ID
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_GATEWAY_ID=xxx ./generate_models.sh
#

set -euo pipefail

# Validate required environment variables
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Error: CLOUDFLARE_API_TOKEN environment variable is required" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "Error: CLOUDFLARE_ACCOUNT_ID environment variable is required" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_GATEWAY_ID:-}" ]]; then
  echo "Error: CLOUDFLARE_GATEWAY_ID environment variable is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/models"

# Fetch models from Cloudflare AI Gateway
echo "Fetching models from Cloudflare AI Gateway..."
API_URL="https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat/models"

RESPONSE=$(curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "${API_URL}")

# Check if the response is valid JSON with data
if ! echo "${RESPONSE}" | jq -e '.data' > /dev/null 2>&1; then
  echo "Error: Invalid API response or no data returned" >&2
  echo "Response: ${RESPONSE}" >&2
  exit 1
fi

# Extract model IDs from response
MODEL_IDS=$(echo "${RESPONSE}" | jq -r '.data[].id')

if [[ -z "${MODEL_IDS}" ]]; then
  echo "Error: No models found in API response" >&2
  exit 1
fi

echo "Found $(echo "${MODEL_IDS}" | wc -l | tr -d ' ') models from API"

# Create a temporary file to track API model files
API_MODEL_FILES=$(mktemp)
trap "rm -f ${API_MODEL_FILES}" EXIT

# Process each model ID
while IFS= read -r MODEL_ID; do
  # Skip empty lines
  [[ -z "${MODEL_ID}" ]] && continue
  
  # Convert model ID to file path based on the API format:
  # - "workers-ai/@cf/vendor/model-name" -> "workers-ai/model-name.toml"
  # - "anthropic/claude-opus-4-5" -> "anthropic/claude-opus-4-5.toml"
  # - "openrouter/anthropic/claude-opus-4.5" -> "openrouter/anthropic/claude-opus-4.5.toml"
  # - "google-ai-studio/gemini-2.5-flash" -> "google-ai-studio/gemini-2.5-flash.toml"
  
  if [[ "${MODEL_ID}" == workers-ai/@cf/* ]]; then
    # Workers AI model: workers-ai/@cf/vendor/model-name -> workers-ai/model-name.toml
    MODEL_NAME=$(echo "${MODEL_ID}" | sed 's|workers-ai/@cf/[^/]*/||')
    MODEL_PATH="workers-ai/${MODEL_NAME}.toml"
  else
    # All other models: keep the path structure as-is
    MODEL_PATH="${MODEL_ID}.toml"
  fi
  
  FULL_PATH="${MODELS_DIR}/${MODEL_PATH}"
  echo "${FULL_PATH}" >> "${API_MODEL_FILES}"
  
  # Create directory if needed
  MODEL_DIR=$(dirname "${FULL_PATH}")
  mkdir -p "${MODEL_DIR}"
  
  # Only create file if it doesn't exist
  if [[ ! -f "${FULL_PATH}" ]]; then
    echo "Creating new model: ${MODEL_PATH}"
    
    # Generate a human-readable name from model ID (use the last part)
    DISPLAY_NAME=$(echo "${MODEL_ID}" | sed 's|.*/||' | sed 's/-/ /g' | sed 's/\b\(.\)/\u\1/g')
    TODAY=$(date +%Y-%m-%d)
    
    cat > "${FULL_PATH}" << EOF
# TODO: Fill in model details
# Model ID: ${MODEL_ID}

name = "${DISPLAY_NAME}"
release_date = "${TODAY}"
last_updated = "${TODAY}"
attachment = false
reasoning = false
temperature = true
tool_call = false
open_weights = false

[limit]
context = 0
output = 0

[modalities]
input = ["text"]
output = ["text"]
EOF
  fi
done <<< "${MODEL_IDS}"

# Find and remove models that are not in the API response
echo ""
echo "Checking for models to remove..."
REMOVED_COUNT=0

# Find all existing .toml files in models directory
while IFS= read -r -d '' EXISTING_FILE; do
  if ! grep -qxF "${EXISTING_FILE}" "${API_MODEL_FILES}"; then
    REL_PATH="${EXISTING_FILE#${MODELS_DIR}/}"
    echo "Removing model not in API: ${REL_PATH}"
    rm -f "${EXISTING_FILE}"
    ((REMOVED_COUNT++)) || true
  fi
done < <(find "${MODELS_DIR}" -name "*.toml" -type f -print0)

# Clean up empty directories
find "${MODELS_DIR}" -type d -empty -delete 2>/dev/null || true

echo ""
echo "Summary:"
echo "  Models from API: $(echo "${MODEL_IDS}" | wc -l | tr -d ' ')"
echo "  Models removed: ${REMOVED_COUNT}"
echo ""
echo "Done! Review the generated files and fill in missing details."
