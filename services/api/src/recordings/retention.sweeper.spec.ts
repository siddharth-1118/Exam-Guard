import { RetentionSweeper } from './retention.sweeper';

describe('RetentionSweeper', () => {
  let sweeper: RetentionSweeper;
  let prismaMock: any;
  let storageMock: any;

  beforeEach(() => {
    prismaMock = {
      recording: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
    };
    storageMock = {
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    sweeper = new RetentionSweeper(prismaMock, storageMock);
  });

  it('should skip sweep when in test mode', async () => {
    process.env.APP_ENV = 'test';
    const result = await sweeper.sweepExpiredRecordings();
    expect(result).toEqual({ purged: 0, errors: 0 });
    expect(prismaMock.recording.findMany).not.toHaveBeenCalled();
  });

  it('should sweep and purge expired recordings for non-active attempts', async () => {
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;

    const expiredRec = {
      id: 'rec-1',
      organizationId: 'org-1',
      attemptId: 'att-1',
      storageKey: 'org-1/recordings/rec-1/combined',
      retentionUntil: new Date(Date.now() - 1000),
    };

    prismaMock.recording.findMany.mockResolvedValue([expiredRec]);
    prismaMock.recording.update.mockResolvedValue({ ...expiredRec, status: 'DELETED' });
    prismaMock.auditLog.create.mockResolvedValue({});

    const result = await sweeper.sweepExpiredRecordings();

    expect(result).toEqual({ purged: 1, errors: 0 });
    expect(storageMock.deleteObject).toHaveBeenCalledWith(expiredRec.storageKey);
    expect(prismaMock.recording.update).toHaveBeenCalledWith({
      where: { id: expiredRec.id },
      data: { status: 'DELETED' },
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'recording.retention-deleted',
        resourceId: expiredRec.id,
      }),
    });
  });
});
