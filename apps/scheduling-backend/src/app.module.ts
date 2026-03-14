import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { UserModule } from "./user/user.module";
import { HealthModule } from "./health/health.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SecretsManagerModule } from "./providers/secrets/secretsManager.module";
import { AuthModule } from "./auth/auth.module";
import { AvailabilityModule } from "./availability/availability.module";
import { SchedulePlanModule } from "./schedule-plan/schedule-plan.module";

@Module({
  controllers: [],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    UserModule,
    AvailabilityModule,
    SchedulePlanModule,
    HealthModule,
    PrismaModule,
    SecretsManagerModule,
  ],
  providers: [],
})
export class AppModule {}
