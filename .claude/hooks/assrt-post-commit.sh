#!/bin/bash
# Assrt: suggest QA testing after git commit/push
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if echo "$COMMAND" | grep -qE 'git (commit|push)'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A git commit/push was just made. If the committed changes affect anything user-facing (UI, routes, forms, APIs), run assrt_test against the local dev server to verify the changes work in a real browser. Use assrt_plan first if you need test cases."}}'
fi
