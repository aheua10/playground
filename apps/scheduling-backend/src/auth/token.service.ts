import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}

  createToken(payload: { id: string; email: string }): Promise<string> {
    return this.jwtService.signAsync({
      sub: payload.id,
      email: payload.email,
    });
  }
}
