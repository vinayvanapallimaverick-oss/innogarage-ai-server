import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertProfileDto } from './dto/profile.dto';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

@Injectable()
export class ProfileService {
  private cloudinaryConfigured = false;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const cloudName = this.configService.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.configService.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.configService.get<string>('CLOUDINARY_API_SECRET');
    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
      this.cloudinaryConfigured = true;
    }
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
      companyName: dto.companyName || null,
      interviewType: dto.interviewType || null,
    };

    if (file) {
      if (!this.cloudinaryConfigured) {
        throw new Error('File upload is not available — Cloudinary is not configured');
      }
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
