import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsEmail } from "class-validator";

export class LoginCredentials {
  @ApiProperty({ required: true, type: String })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: true, type: String })
  @IsString()
  password!: string;
}

export class RegisterCredentials {
  @ApiProperty({ required: true, type: String })
  @IsEmail()
  email!: string;

  @ApiProperty({ required: true, type: String })
  @IsString()
  password!: string;

  @ApiProperty({ required: true, type: String })
  @IsString()
  name!: string;
}

export class GoogleTokenDto {
  @ApiProperty({ required: true, type: String })
  @IsString()
  token!: string;
}
