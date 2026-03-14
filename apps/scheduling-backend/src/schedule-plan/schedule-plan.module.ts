import { Module } from "@nestjs/common";
import { SchedulePlanService } from "./schedule-plan.service";
import { SchedulePlanController } from "./schedule-plan.controller";
import { ScheduleGeneratorService } from "../schedule/schedule-generator.service";
import { AvailabilityModule } from "../availability/availability.module";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule, AvailabilityModule],
  controllers: [SchedulePlanController],
  providers: [SchedulePlanService, ScheduleGeneratorService],
  exports: [SchedulePlanService],
})
export class SchedulePlanModule {}
