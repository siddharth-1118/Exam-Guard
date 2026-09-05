import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@examguard/database';
import { QuestionType } from '@examguard/types';
import { PrismaService } from '../prisma/prisma.service';

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue);
}
import type { UserContext } from '../common/types';
import { CreateQuestionDto, UpdateQuestionDto } from './dto';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createBank(user: UserContext, name: string, description?: string) {
    return this.prisma.questionBank.create({
      data: {
        organizationId: user.orgId!,
        name,
        description,
        createdBy: user.userId,
      },
    });
  }

  async listBanks(user: UserContext) {
    return this.prisma.questionBank.findMany({
      where: { organizationId: user.orgId! },
      include: { _count: { select: { questions: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createQuestion(user: UserContext, dto: CreateQuestionDto, bankId?: string) {
    if (bankId) {
      const bank = await this.prisma.questionBank.findFirst({
        where: { id: bankId, organizationId: user.orgId! },
      });
      if (!bank) throw new NotFoundException('Question bank not found');
    }
    const data = {
      organizationId: user.orgId!,
      bankId: bankId ?? null,
      type: dto.type as QuestionType,
      text: dto.text,
      marks: dto.marks ?? 1,
      negativeMarks: dto.negativeMarks ?? 0,
      difficulty: dto.difficulty ?? 'MEDIUM',
      metadata: toJson(dto.metadata),
      createdBy: user.userId,
    };
    return this.prisma.$transaction(async (tx) => {
      const question = await tx.question.create({ data });
      if (dto.options?.length) {
        await tx.questionOption.createMany({
          data: dto.options.map((o, i) => ({
            questionId: question.id,
            text: o.text,
            isCorrect: Boolean(o.isCorrect),
            order: o.order ?? i + 1,
          })),
        });
      }
      // Read back inside the transaction (the outer client cannot see uncommitted rows)
      return tx.question.findUnique({
        where: { id: question.id },
        include: { options: { orderBy: { order: 'asc' } } },
      });
    });
  }

  async listQuestions(user: UserContext, bankId?: string) {
    return this.prisma.question.findMany({
      where: { organizationId: user.orgId!, ...(bankId ? { bankId } : {}) },
      include: { options: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateQuestion(user: UserContext, questionId: string, dto: UpdateQuestionDto) {
    const existing = await this.prisma.question.findFirst({
      where: { id: questionId, organizationId: user.orgId! },
    });
    if (!existing) throw new NotFoundException('Question not found');

    const activeAttempts = await this.prisma.examAttempt.count({
      where: {
        exam: { questions: { some: { questionId } } },
      },
    });
    if (activeAttempts > 0) {
      throw new BadRequestException('Question cannot be modified because it is linked to an exam with student attempts');
    }

    return this.prisma.$transaction(async (tx) => {
      const data: Record<string, unknown> = {};
      if (dto.text !== undefined) data.text = dto.text;
      if (dto.marks !== undefined) data.marks = dto.marks;
      if (dto.negativeMarks !== undefined) data.negativeMarks = dto.negativeMarks;
      if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
      if (dto.metadata !== undefined) data.metadata = dto.metadata;
      await tx.question.update({ where: { id: questionId }, data });
      if (dto.options) {
        await tx.questionOption.deleteMany({ where: { questionId } });
        await tx.questionOption.createMany({
          data: dto.options.map((o, i) => ({
            questionId,
            text: o.text,
            isCorrect: Boolean(o.isCorrect),
            order: o.order ?? i + 1,
          })),
        });
      }
      return tx.question.findUnique({
        where: { id: questionId },
        include: { options: { orderBy: { order: 'asc' } } },
      });
    });
  }

  async deleteQuestion(user: UserContext, questionId: string) {
    const existing = await this.prisma.question.findFirst({
      where: { id: questionId, organizationId: user.orgId! },
    });
    if (!existing) throw new NotFoundException('Question not found');

    const activeAttempts = await this.prisma.examAttempt.count({
      where: {
        exam: { questions: { some: { questionId } } },
      },
    });
    if (activeAttempts > 0) {
      throw new BadRequestException('Question cannot be deleted because it is linked to an exam with student attempts');
    }

    await this.prisma.question.delete({ where: { id: questionId } });
    return { deleted: true };
  }

  async bulkImport(user: UserContext, dtos: CreateQuestionDto[], bankId?: string) {
    if (bankId) {
      const bank = await this.prisma.questionBank.findFirst({
        where: { id: bankId, organizationId: user.orgId! },
      });
      if (!bank) throw new NotFoundException('Question bank not found');
    }

    const createdQuestions = await this.prisma.$transaction(async (tx) => {
      const createdList = [];
      for (const dto of dtos) {
        const question = await tx.question.create({
          data: {
            organizationId: user.orgId!,
            bankId: bankId ?? null,
            type: dto.type as QuestionType,
            text: dto.text,
            marks: dto.marks ?? 1,
            negativeMarks: dto.negativeMarks ?? 0,
            difficulty: dto.difficulty ?? 'MEDIUM',
            metadata: toJson(dto.metadata),
            createdBy: user.userId,
          },
        });
        if (dto.options?.length) {
          await tx.questionOption.createMany({
            data: dto.options.map((o, i) => ({
              questionId: question.id,
              text: o.text,
              isCorrect: Boolean(o.isCorrect),
              order: o.order ?? i + 1,
            })),
          });
        }
        createdList.push(question.id);
      }
      return createdList;
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.orgId!,
        actorUserId: user.userId,
        actorEmail: user.email,
        action: 'questions.bulk-import',
        resourceType: 'QuestionBank',
        resourceId: bankId ?? 'standalone',
        detail: { count: createdQuestions.length },
      },
    });

    return { importedCount: createdQuestions.length, questionIds: createdQuestions };
  }

  async exportQuestions(user: UserContext, bankId?: string) {
    const questions = await this.prisma.question.findMany({
      where: { organizationId: user.orgId!, ...(bankId ? { bankId } : {}) },
      include: { options: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return questions.map((q) => ({
      type: q.type,
      text: q.text,
      marks: q.marks,
      negativeMarks: q.negativeMarks,
      difficulty: q.difficulty,
      metadata: q.metadata,
      options: q.options.map((o) => ({
        text: o.text,
        isCorrect: o.isCorrect,
        order: o.order,
      })),
    }));
  }

  private async withOptions(questionId: string) {
    return this.prisma.question.findUnique({
      where: { id: questionId },
      include: { options: { orderBy: { order: 'asc' } } },
    });
  }
}