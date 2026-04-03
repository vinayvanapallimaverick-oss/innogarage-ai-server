import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertProfileDto } from './dto/profile.dto';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class ProfileService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.configService.get<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get<string>('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get<string>('CLOUDINARY_API_SECRET'),
    });
  }

  private uploadToCloudinary(
    buffer: Buffer,
    originalName: string,
    userId: string,
  ): Promise<{ publicId: string; url: string }> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `innogarage/resumes/${userId}`,
          public_id: `resume_${Date.now()}`,
          resource_type: 'raw',
          use_filename: false,
        },
        (error, result) => {
          if (error || !result) return reject(error || new Error('Cloudinary upload failed'));
          resolve({ publicId: result.public_id, url: result.secure_url });
        },
      );
      Readable.from(buffer).pipe(uploadStream);
    });
  }

  async upsert(
    userId: string,
    dto: UpsertProfileDto,
    file?: Express.Multer.File,
  ) {
    const data: any = {
      prompt: dto.prompt,
      role: dto.role,
      experience: dto.experience,
    };

    if (file) {
      // Delete old resume from Cloudinary if it exists
      const existing = await this.prisma.profile.findUnique({ where: { userId } });
      if (existing?.resumeCloudinaryId) {
        await cloudinary.uploader.destroy(existing.resumeCloudinaryId, { resource_type: 'raw' }).catch(() => {});
      }

      // Upload new resume to Cloudinary
      const { publicId, url } = await this.uploadToCloudinary(file.buffer, file.originalname, userId);
      data.resumeFilename = file.originalname;
      data.resumeCloudinaryId = publicId;
      data.resumeUrl = url;
    }

    const profile = await this.prisma.profile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return profile;
  }

  async getByUserId(userId: string) {
    return this.prisma.profile.findUnique({ where: { userId } });
  }
}
