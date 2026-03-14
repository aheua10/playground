import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SchedulePlanService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    name: string;
    startDate: Date;
    endDate: Date;
    maxHomeDays: number;
    minWorkDays: number;
    createdById: string;
    memberUserIds: string[];
  }) {
    return this.prisma.schedulePlan.create({
      data: {
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        maxHomeDays: data.maxHomeDays,
        minWorkDays: data.minWorkDays,
        createdById: data.createdById,
        members: {
          create: data.memberUserIds.map((userId) => ({ userId })),
        },
      },
      include: { members: { include: { user: true } } },
    });
  }

  async findAll() {
    return this.prisma.schedulePlan.findMany({
      include: {
        members: { include: { user: true } },
        _count: { select: { assignments: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: string) {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id },
      include: {
        members: { include: { user: true } },
        assignments: { orderBy: [{ date: "asc" }, { userId: "asc" }] },
      },
    });
    if (!plan) throw new NotFoundException("Schedule plan not found");
    return plan;
  }

  async update(
    id: string,
    data: {
      name?: string;
      startDate?: Date;
      endDate?: Date;
      maxHomeDays?: number;
      minWorkDays?: number;
    }
  ) {
    return this.prisma.schedulePlan.update({
      where: { id },
      data,
      include: { members: { include: { user: true } } },
    });
  }

  async delete(id: string) {
    return this.prisma.schedulePlan.delete({ where: { id } });
  }

  async addMember(schedulePlanId: string, userId: string) {
    return this.prisma.scheduleMember.create({
      data: { schedulePlanId, userId },
      include: { user: true },
    });
  }

  async removeMember(schedulePlanId: string, userId: string) {
    return this.prisma.scheduleMember.delete({
      where: { schedulePlanId_userId: { schedulePlanId, userId } },
    });
  }

  async updateAssignment(
    assignmentId: string,
    isHome: boolean
  ) {
    return this.prisma.scheduleAssignment.update({
      where: { id: assignmentId },
      data: { isHome, isManualOverride: true },
    });
  }
}
