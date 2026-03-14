import {
  Controller,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AvailabilityService } from "./availability.service";
import { DefaultAuthGuard } from "../auth/defaultAuth.guard";
import { IsDateString, IsEnum, IsOptional, IsString } from "class-validator";
import { UrgencyLevel } from "@prisma/client";
import { ApiProperty } from "@nestjs/swagger";

class UpsertAvailabilityDto {
  @ApiProperty({ type: String })
  @IsDateString()
  date!: string;

  @ApiProperty({ enum: UrgencyLevel })
  @IsEnum(UrgencyLevel)
  urgency!: UrgencyLevel;

  @ApiProperty({ type: String, required: false })
  @IsOptional()
  @IsString()
  note?: string;
}

@ApiTags("availability")
@Controller("availability")
@UseGuards(DefaultAuthGuard)
export class AvailabilityController {
  constructor(private readonly service: AvailabilityService) {}

  @Get()
  async findMine(
    @Req() req: any,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string
  ) {
    return this.service.findByUser(
      req.user.id,
      new Date(startDate),
      new Date(endDate)
    );
  }

  @Put()
  async upsert(@Req() req: any, @Body() body: UpsertAvailabilityDto) {
    return this.service.upsert(
      req.user.id,
      new Date(body.date),
      body.urgency,
      body.note
    );
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    return this.service.delete(id);
  }
}
