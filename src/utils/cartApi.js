/**
 * How the client treats `/api/cart`. There is no cart UI in this slice;
 * the next slice calls this so an old production server (404) stays quiet.
 *
 * 404: local-only, no error, do not retry until the next sign-in.
 * 401: sign-in prompt, do not write a cart.
 * Anything else: keep the local cart, retry later, no toast.
 */
export function interpretCartResponse(status) {
  if (status === 404) {
    return {
      localOnly: true,
      showError: false,
      retry: false,
      auth: false,
    };
  }
  if (status === 401) {
    return {
      localOnly: false,
      showError: false,
      retry: false,
      auth: true,
    };
  }
  return {
    localOnly: false,
    showError: false,
    retry: true,
    auth: false,
  };
}
