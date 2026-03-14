import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiProperty } from "@nestjs/swagger";
import { SchedulePlanService } from "./schedule-plan.service";
import { ScheduleGeneratorService } from "../schedule/schedule-generator.service";
import { DefaultAuthGuard } from "../auth/defaultAuth.guard";
import {
  IsString,
  IsDateString,
  IsInt,
  IsArray,
  IsBoolean,
  Min,
} from "class-validator";

class CreateSchedulePlanDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty()
  @IsDateString()
  startDate!: string;

  @ApiProperty()
  @IsDateString()
  endDate!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  maxHomeDays!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  minWorkDays!: number;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  memberUserIds!: string[];
}

class UpdateSchedulePlanDto {
  @ApiProperty({ required: false })
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false })
  @IsDateString()
  endDate?: string;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(0)
  maxHomeDays?: number;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(0)
  minWorkDays?: number;
}

class AddMemberDto {
  @ApiProperty()
  @IsString()
  userId!: string;
}

class UpdateAssignmentDto {
  @ApiProperty()
  @IsBoolean()
  isHome!: boolean;
}

@ApiTags("schedule-plans")
@Controller("schedule-plans")
@UseGuards(DefaultAuthGuard)
export class SchedulePlanController {
  constructor(
    private readonly service: SchedulePlanService,
    private readonly generator: ScheduleGeneratorService
  ) {}

  @Post()
  async create(@Req() req: any, @Body() body: CreateSchedulePlanDto) {
    return this.service.create({
      name: body.name,
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
      maxHomeDays: body.maxHomeDays,
      minWorkDays: body.minWorkDays,
      createdById: req.user.id,
      memberUserIds: body.memberUserIds,
    });
  }

  @Get()
  async findAll() {
    return this.service.findAll();
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    return this.service.findById(id);
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: UpdateSchedulePlanDto) {
    const data: any = { ...body };
    if (body.startDate) data.startDate = new Date(body.startDate);
    if (body.endDate) data.endDate = new Date(body.endDate);
    return this.service.update(id, data);
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.service.delete(id);
  }

  @Post(":id/members")
  async addMember(@Param("id") id: string, @Body() body: AddMemberDto) {
    return this.service.addMember(id, body.userId);
  }

  @Delete(":id/members/:userId")
  async removeMember(
    @Param("id") id: string,
    @Param("userId") userId: string
  ) {
    return this.service.removeMember(id, userId);
  }

  @Post(":id/generate")
  async generate(@Param("id") id: string) {
    return this.generator.generate(id);
  }

  @Patch(":id/assignments/:assignmentId")
  async updateAssignment(
    @Param("assignmentId") assignmentId: string,
    @Body() body: UpdateAssignmentDto
  ) {
    return this.service.updateAssignment(assignmentId, body.isHome);
  }
}
