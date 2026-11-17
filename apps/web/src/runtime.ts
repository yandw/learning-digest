import { createAdminFlow } from "../public/js/admin.js";
import { createApiClient } from "../public/js/api-client.js";
import { createCredentialStore } from "../public/js/credentials.js";
import { createLibraryFlow } from "../public/js/library.js";
import { createLinkFlow } from "../public/js/link-flow.js";
import { createLoginFlow } from "../public/js/login-flow.js";
import { createSessionRevalidator } from "../public/js/session-revalidate.js";

export type LearningRuntime = {
  login: any;
  library: any;
  credentials: any;
  openDetail: (id: string) => void;
  api?: any;
  admin?: any;
  session?: any;
  subscribeSessionExpired?: (listener: () => void) => () => void;
};

/** The production composition root; all contract decisions stay in the tested flows. */
export function createLearningRuntime(): LearningRuntime {
  const credentials = createCredentialStore({ storage: window.localStorage });
  const listeners = new Set<() => void>();
  const notifySessionExpired = () => listeners.forEach((listener) => listener());
  let login: any;
  let library: any;
  let admin: any;
  const api: any = createApiClient({
    fetchImpl: (path: string, init?: RequestInit) => fetch(path, init),
    credentials,
    onUnauthorized: () => {
      login.handleSessionExpired();
      library.reset();
      admin.reset();
      notifySessionExpired();
    },
  });
  login = createLoginFlow({ api, credentials });
  const identityExtractor =
    (window as any).YTD_PLATFORM_VIDEO_ID || { extractVideoIdentity: () => null };
  library = createLibraryFlow({ api, identity: identityExtractor });
  admin = createAdminFlow({ api });
  const session = createSessionRevalidator({
    api,
    isAuthenticated: () => login.getState().state === "authenticated",
  });

  return {
    login,
    library,
    credentials,
    api,
    admin,
    session,
    subscribeSessionExpired(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDetail(id: string) {
      return library.openDetail(id);
    },
  };
}

export function createLinkRuntime() {
  const credentials = createCredentialStore({ storage: window.localStorage });
  const listeners = new Set<() => void>();
  let link: any;
  const api = createApiClient({
    fetchImpl: (path: string, init?: RequestInit) => fetch(path, init),
    credentials,
    onUnauthorized: () => {
      void link.start().then(() => listeners.forEach((listener) => listener()));
    },
  });
  link = createLinkFlow({ api, credentials });
  return {
    link,
    subscribeSessionExpired(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
