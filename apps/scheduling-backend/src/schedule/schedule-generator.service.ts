import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AvailabilityService } from "../availability/availability.service";
import { UrgencyLevel } from "@prisma/client";

interface ConflictReport {
  userId: string;
  reason: string;
}

@Injectable()
export class ScheduleGeneratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availabilityService: AvailabilityService
  ) {}

  async generate(schedulePlanId: string) {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: schedulePlanId },
      include: { members: true },
    });

    if (!plan) {
      throw new BadRequestException("Schedule plan not found");
    }

    const memberIds = plan.members.map((m) => m.userId);
    const { startDate, endDate, maxHomeDays, minWorkDays } = plan;

    // Get all dates in range
    const dates: Date[] = [];
    const current = new Date(startDate);
    while (current <= endDate) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    const totalDays = dates.length;

    // Load availability for all members
    const availabilities = await this.availabilityService.findByUsers(
      memberIds,
      startDate,
      endDate
    );

    // Build lookup: userId -> dateString -> urgency
    const availMap = new Map<string, Map<string, UrgencyLevel>>();
    for (const userId of memberIds) {
      availMap.set(userId, new Map());
    }
    for (const a of availabilities) {
      const userMap = availMap.get(a.userId);
      if (userMap) {
        userMap.set(a.date.toISOString().split("T")[0], a.urgency);
      }
    }

    // Track home days per user
    const homeDaysCount = new Map<string, number>();
    // Track assignments: userId -> dateStr -> isHome
    const assignments = new Map<string, Map<string, boolean>>();

    for (const userId of memberIds) {
      homeDaysCount.set(userId, 0);
      assignments.set(userId, new Map());
    }

    const conflicts: ConflictReport[] = [];

    // Pass 1: Hard constraints — all RED days must be home
    for (const userId of memberIds) {
      const userAvail = availMap.get(userId)!;
      const userAssignments = assignments.get(userId)!;

      for (const date of dates) {
        const dateStr = date.toISOString().split("T")[0];
        const urgency = userAvail.get(dateStr) || UrgencyLevel.GREEN;

        if (urgency === UrgencyLevel.RED) {
          userAssignments.set(dateStr, true); // home
          homeDaysCount.set(userId, (homeDaysCount.get(userId) || 0) + 1);
        }
      }

      // Check if RED days alone exceed constraints
      const redCount = homeDaysCount.get(userId)!;
      if (redCount > maxHomeDays) {
        conflicts.push({
          userId,
          reason: `Has ${redCount} mandatory home days (RED) but max is ${maxHomeDays}`,
        });
      }
      if (totalDays - redCount < minWorkDays) {
        conflicts.push({
          userId,
          reason: `Has ${redCount} mandatory home days (RED), leaving only ${totalDays - redCount} work days (min is ${minWorkDays})`,
        });
      }
    }

    // Pass 2: Cluster scoring — score each date by YELLOW demand
    const dateScores: { date: Date; dateStr: string; score: number }[] = [];
    for (const date of dates) {
      const dateStr = date.toISOString().split("T")[0];
      let score = 0;
      for (const userId of memberIds) {
        const userAvail = availMap.get(userId)!;
        const userAssignments = assignments.get(userId)!;
        if (userAssignments.has(dateStr)) continue; // already assigned (RED)
        const urgency = userAvail.get(dateStr) || UrgencyLevel.GREEN;
        if (urgency === UrgencyLevel.YELLOW) score++;
      }
      dateScores.push({ date, dateStr, score });
    }

    // Sort by score descending (most popular home-request dates first)
    dateScores.sort((a, b) => b.score - a.score);

    // Pass 3: Clustered allocation — grant YELLOW days on popular dates
    for (const { date, dateStr } of dateScores) {
      for (const userId of memberIds) {
        const userAssignments = assignments.get(userId)!;
        if (userAssignments.has(dateStr)) continue; // already assigned

        const userAvail = availMap.get(userId)!;
        const urgency = userAvail.get(dateStr) || UrgencyLevel.GREEN;

        if (urgency !== UrgencyLevel.YELLOW) continue;

        const currentHome = homeDaysCount.get(userId)!;
        const remainingDays =
          totalDays -
          currentHome -
          1; // if we grant this one, remaining unassigned

        // Check constraints before granting
        if (currentHome + 1 > maxHomeDays) continue;

        // Count how many days are still unassigned for this user
        let unassignedCount = 0;
        for (const d of dates) {
          const ds = d.toISOString().split("T")[0];
          if (!userAssignments.has(ds) && ds !== dateStr) unassignedCount++;
        }
        // After granting this home day, remaining work days = unassigned (all become work)
        // We need: (unassignedCount) >= minWorkDays - (already assigned work days)
        const currentWorkDays = Array.from(userAssignments.values()).filter(
          (isHome) => !isHome
        ).length;
        const potentialWorkDays = currentWorkDays + unassignedCount;
        if (potentialWorkDays < minWorkDays) continue;

        // Grant home day
        userAssignments.set(dateStr, true);
        homeDaysCount.set(userId, currentHome + 1);
      }
    }

    // Pass 4: All remaining unassigned days → at work
    for (const userId of memberIds) {
      const userAssignments = assignments.get(userId)!;
      for (const date of dates) {
        const dateStr = date.toISOString().split("T")[0];
        if (!userAssignments.has(dateStr)) {
          userAssignments.set(dateStr, false); // at work
        }
      }
    }

    // Delete existing assignments for this plan (regenerate)
    await this.prisma.scheduleAssignment.deleteMany({
      where: { schedulePlanId, isManualOverride: false },
    });

    // Write assignments to database
    const assignmentRecords = [];
    for (const userId of memberIds) {
      const userAssignments = assignments.get(userId)!;
      for (const [dateStr, isHome] of userAssignments) {
        assignmentRecords.push({
          schedulePlanId,
          userId,
          date: new Date(dateStr),
          isHome,
          isManualOverride: false,
        });
      }
    }

    // Use createMany for efficiency
    await this.prisma.scheduleAssignment.createMany({
      data: assignmentRecords,
      skipDuplicates: true,
    });

    return {
      totalDays,
      memberCount: memberIds.length,
      assignmentsCreated: assignmentRecords.length,
      conflicts,
      summary: memberIds.map((userId) => ({
        userId,
        homeDays: homeDaysCount.get(userId),
        workDays: totalDays - (homeDaysCount.get(userId) || 0),
      })),
    };
  }
}
