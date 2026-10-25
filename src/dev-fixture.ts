import siteConfig from "../site.config.json";

export const [FIRST_ADMIN, SECOND_ADMIN] = siteConfig.admins;

export const DEV_MERIT = {
  admins: [FIRST_ADMIN.email, SECOND_ADMIN.email],
  family: ["ada@example.com"],
  friends: ["bea@example.com"],
  grants: { "bea@example.com": ["jewelry"] },
  contacts: {
    [FIRST_ADMIN.email]: FIRST_ADMIN.name,
    [SECOND_ADMIN.email]: SECOND_ADMIN.name,
    "ada@example.com": "Ada Family",
    "bea@example.com": "Bea Friend",
    "cara@example.com": "Cara Stone",
  },
};
