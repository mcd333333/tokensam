function httpsLink(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function getAppInstallLinks() {
  return {
    android: httpsLink(process.env.TOKEN_SAMURAI_ANDROID_INSTALL_URL),
    ios: httpsLink(process.env.TOKEN_SAMURAI_IOS_INSTALL_URL),
  };
}
