import { ApiProperty } from "@nestjs/swagger";

export class UserInfo {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  role!: string;

  @ApiProperty({ type: String, nullable: true })
  accessToken?: string;
}
