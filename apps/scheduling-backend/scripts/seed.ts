import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcrypt";

if (require.main === module) {
  dotenv.config();

  const { BCRYPT_SALT } = process.env;

  if (!BCRYPT_SALT) {
    throw new Error("BCRYPT_SALT environment variable must be defined");
  }
  const salt = Number(BCRYPT_SALT);

  seed(salt).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function seed(bcryptSalt: number) {
  console.info("Seeding database...");

  const client = new PrismaClient();

  // Create a default manager user
  await client.user.upsert({
    where: { email: "admin@scheduling.app" },
    update: {},
    create: {
      email: "admin@scheduling.app",
      name: "Admin",
      password: await hash("admin123", bcryptSalt),
      role: "MANAGER",
    },
  });

  void client.$disconnect();

  console.info("Seeded database successfully");
}
