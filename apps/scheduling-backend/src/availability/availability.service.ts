import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UrgencyLevel } from "@prisma/client";

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async findByUser(userId: string, startDate: Date, endDate: Date) {
    return this.prisma.availability.findMany({
      where: {
        userId,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    });
  }

  async findByUsers(userIds: string[], startDate: Date, endDate: Date) {
    return this.prisma.availability.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: startDate, lte: endDate },
      },
      include: { user: true },
      orderBy: { date: "asc" },
    });
  }

  async upsert(
    userId: string,
    date: Date,
    urgency: UrgencyLevel,
    note?: string
  ) {
    return this.prisma.availability.upsert({
      where: { userId_date: { userId, date } },
      update: { urgency, note },
      create: { userId, date, urgency, note },
    });
  }

  async delete(id: string) {
    return this.prisma.availability.delete({ where: { id } });
  }
}
