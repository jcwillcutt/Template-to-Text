// ----------------------------------------------------------------------------------------------
// GRAPHQL RESPONSE HELPERS
// ----------------------------------------------------------------------------------------------

// Formats a GraphQL response's top-level `errors` and/or mutation `userErrors` into one display
// string, or null when there are none. Top-level errors are reported in preference to userErrors,
// matching how every call site in this file already prioritized them before this was extracted.
function formatGraphQLErrors(
  errors: any[] | null | undefined,
  userErrors: any[] | null | undefined,
): string | null {
  if (errors && errors.length) {
    return errors.map((e: any) => e.message).join(', ');
  }
  if (userErrors && userErrors.length) {
    return userErrors
      .map((e: any) => (e.field ? `${e.field}: ${e.message}` : e.message))
      .join(', ');
  }
  return null;
}

