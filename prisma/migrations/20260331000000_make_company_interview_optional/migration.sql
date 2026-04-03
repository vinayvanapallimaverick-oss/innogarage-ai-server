-- AlterTable: make companyName and interviewType nullable
ALTER TABLE "profiles" ALTER COLUMN "companyName" DROP NOT NULL;
ALTER TABLE "profiles" ALTER COLUMN "interviewType" DROP NOT NULL;
