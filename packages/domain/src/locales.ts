/** The interface languages (N-I18N-01): the dictionaries, the account preference, the mails. */
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
