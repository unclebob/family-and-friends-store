interface Env {
  MERIT_SECRET: string;
  CODE_PEPPER: string;
  RESEND_API_KEY: string;
  // Signs the photo links in the new-items email. Unset means no photos in that email.
  PHOTO_LINK_KEY?: string;
}
