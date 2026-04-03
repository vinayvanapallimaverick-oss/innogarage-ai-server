import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { ProfileService } from './profile.service';
import { UpsertProfileDto } from './dto/profile.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(
    FileInterceptor('resume', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      fileFilter: (_req, file, cb) => {
        const allowed = ['.pdf', '.doc', '.docx', '.txt'];
        const ext = extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
          cb(null, true);
        } else {
          cb(new Error('Only .pdf, .doc, .docx, .txt files are allowed'), false);
        }
      },
    }),
  )
  async upsert(
    @Request() req: any,
    @Body() dto: UpsertProfileDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.profileService.upsert(req.user.sub, dto, file);
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  async get(@Request() req: any) {
    return this.profileService.getByUserId(req.user.sub);
  }
}
