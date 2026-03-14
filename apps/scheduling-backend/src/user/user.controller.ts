import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { UserService } from "./user.service";
import { DefaultAuthGuard } from "../auth/defaultAuth.guard";

@ApiTags("users")
@Controller("users")
@UseGuards(DefaultAuthGuard)
export class UserController {
  constructor(private readonly service: UserService) {}

  @Get()
  async findAll() {
    return this.service.findAll();
  }

  @Get(":id")
  async findOne(@Param("id") id: string) {
    return this.service.findById(id);
  }
}
