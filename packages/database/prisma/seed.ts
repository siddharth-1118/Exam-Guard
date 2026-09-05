/**
 * Development seed (spec §67) — dev-only credentials, clearly marked.
 * Run: pnpm db:seed
 */
import { PrismaClient, type RoleName } from '@prisma/client';
import { hashPassword, ALL_PERMISSIONS, ROLE_PERMISSIONS } from '@examguard/security';

const prisma = new PrismaClient();

const DEV_PASSWORD = 'ExamGuard!Dev2026'; // DEV ONLY — never used in production

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Platform-wide administrator',
  ORG_ADMIN: 'Organization administrator',
  EXAM_MANAGER: 'Creates and manages exams',
  MONITOR: 'Live proctoring of assigned students',
  STUDENT: 'Takes assigned exams',
};

async function seedRoles(): Promise<Record<RoleName, string>> {
  const roleIds = {} as Record<RoleName, string>;
  for (const permissionName of ALL_PERMISSIONS) {
    const [resource] = permissionName.split(':');
    await prisma.permission.upsert({
      where: { name: permissionName },
      update: { resource },
      create: { name: permissionName, resource },
    });
  }
  for (const [roleName, description] of Object.entries(ROLE_DESCRIPTIONS) as Array<
    [RoleName, string]
  >) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: { description },
      create: { name: roleName, description },
    });
    roleIds[roleName] = role.id;
    // Sync role_permissions with the compile-time map
    const wanted = ROLE_PERMISSIONS[roleName];
    const perms = await prisma.permission.findMany({ where: { name: { in: wanted } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
  return roleIds;
}

async function upsertUser(email: string, firstName: string, lastName: string) {
  const passwordHash = await hashPassword(DEV_PASSWORD);
  return prisma.user.upsert({
    where: { email },
    // Always refresh the hash so re-seeding keeps credentials valid even if
    // the password module changes during development.
    update: { firstName, lastName, isActive: true, passwordHash },
    create: { email, firstName, lastName, passwordHash },
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_SEED !== 'true') {
    throw new Error('Refusing to run development seed in production. Set ALLOW_DEV_SEED=true to override.');
  }

  console.log('Seeding ExamGuard dev environment…');

  const roleIds = await seedRoles();

  // Super admin (global role, no org)
  const superAdmin = await upsertUser('superadmin@examguard.dev', 'Alex', 'Root');
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: superAdmin.id, roleId: roleIds.SUPER_ADMIN } },
    update: {},
    create: { userId: superAdmin.id, roleId: roleIds.SUPER_ADMIN },
  });

  // Demo organization
  const org = await prisma.organization.upsert({
    where: { slug: 'northstar-university' },
    update: { name: 'Northstar University' },
    create: {
      name: 'Northstar University',
      slug: 'northstar-university',
      plan: 'enterprise',
      settings: { allowStudentWebDelivery: true },
    },
  });

  async function addMember(email: string, firstName: string, lastName: string, role: RoleName) {
    const user = await upsertUser(email, firstName, lastName);
    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      update: { roleId: roleIds[role], isActive: true },
      create: { organizationId: org.id, userId: user.id, roleId: roleIds[role] },
    });
    return user;
  }

  const orgAdmin = await addMember('admin@northstar.edu', 'Priya', 'Sharma', 'ORG_ADMIN');
  const teacher = await addMember('teacher@northstar.edu', 'Marcus', 'Chen', 'EXAM_MANAGER');
  const monitor = await addMember('monitor@northstar.edu', 'Ravi', 'Kumar', 'MONITOR');

  const monitorProfile = await prisma.monitor.upsert({
    where: { userId: monitor.id },
    update: { organizationId: org.id },
    create: { userId: monitor.id, organizationId: org.id },
  });

  // Students
  const studentEmails = [
    ['student01@northstar.edu', 'Aisha', 'Bello', 'NS-2026-001'],
    ['student02@northstar.edu', 'Diego', 'Ramirez', 'NS-2026-002'],
    ['student03@northstar.edu', 'Mei', 'Tanaka', 'NS-2026-003'],
    ['student04@northstar.edu', 'Omar', 'Haddad', 'NS-2026-004'],
    ['student05@northstar.edu', 'Elena', 'Petrova', 'NS-2026-005'],
  ] as const;

  const students: string[] = [];
  for (const [email, first, last, code] of studentEmails) {
    const user = await addMember(email, first, last, 'STUDENT');
    const profile = await prisma.student.upsert({
      where: { userId: user.id },
      update: { organizationId: org.id, studentCode: code },
      create: { userId: user.id, organizationId: org.id, studentCode: code },
    });
    students.push(profile.id);
  }

  // Question bank + questions (all 7 types, spec §7)
  const bank = await prisma.questionBank.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: { organizationId: org.id, name: 'Computer Science Fundamentals' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      organizationId: org.id,
      name: 'Computer Science Fundamentals',
      description: 'Intro CS question bank',
      createdBy: teacher.id,
    },
  });

  // Idempotency: drop the bank's previous rows before re-creating them so
  // `pnpm db:seed` can be run any number of times.
  await prisma.questionOption.deleteMany({
    where: { question: { bankId: bank.id } },
  });
  await prisma.question.deleteMany({ where: { bankId: bank.id } });

  const questions = await prisma.question.createMany({
    data: [
      { organizationId: org.id, bankId: bank.id, type: 'SINGLE_CHOICE', text: 'Which keyword declares a constant in Java?', marks: 1, negativeMarks: 0.25, difficulty: 'EASY', createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'MULTIPLE_CHOICE', text: 'Which of the following are primitive types in Java?', marks: 2, negativeMarks: 0.5, difficulty: 'MEDIUM', createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'TRUE_FALSE', text: 'In Java, the `String` type is a reference type.', marks: 1, negativeMarks: 0.25, difficulty: 'EASY', createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'SHORT_ANSWER', text: 'Name the JVM component responsible for garbage collection.', marks: 2, difficulty: 'MEDIUM', createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'LONG_ANSWER', text: 'Explain the difference between an abstract class and an interface in Java, with examples.', marks: 5, difficulty: 'HARD', createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'NUMERIC', text: 'What is the time complexity (Big-O) of binary search on a sorted array of n elements? Answer with the exponent only, e.g. for O(n) answer 1, for O(1) answer 0.', marks: 1, negativeMarks: 0.25, difficulty: 'MEDIUM', metadata: { tolerance: 0.001 }, createdBy: teacher.id },
      { organizationId: org.id, bankId: bank.id, type: 'CODE', text: 'Write a Java method that returns the sum of an integer array.', marks: 5, difficulty: 'HARD', metadata: { language: 'java' }, createdBy: teacher.id },
    ],
  });

  const qRows = await prisma.question.findMany({
    where: { bankId: bank.id },
    orderBy: { createdAt: 'asc' },
  });
  if (qRows.length !== questions.count) {
    throw new Error('Unexpected question count after seed');
  }

  // Options (answers are server-side only — never sent to students)
  const optA = 'final', optB = 'static', optC = 'const', optD = 'let';
  const optData = [
    { q: qRows[0], rows: [
      { text: optA, isCorrect: true, order: 1 },
      { text: optB, isCorrect: false, order: 2 },
      { text: optC, isCorrect: false, order: 3 },
      { text: optD, isCorrect: false, order: 4 },
    ]},
    { q: qRows[1], rows: [
      { text: 'int', isCorrect: true, order: 1 },
      { text: 'double', isCorrect: true, order: 2 },
      { text: 'String', isCorrect: false, order: 3 },
      { text: 'boolean', isCorrect: true, order: 4 },
    ]},
    { q: qRows[2], rows: [
      { text: 'True', isCorrect: true, order: 1 },
      { text: 'False', isCorrect: false, order: 2 },
    ]},
    { q: qRows[5], rows: [
      { text: '0', isCorrect: true, order: 1 }, // log2(n) => O(log n); exponent 0 in n^k terms
    ]},
  ];
  for (const entry of optData) {
    await prisma.questionOption.createMany({ data: entry.rows.map((r) => ({ questionId: entry.q.id, ...r })) });
  }

  // Exam
  const exam = await prisma.exam.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    update: { organizationId: org.id, name: 'Java Programming — Midterm', durationMinutes: 60 },
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      organizationId: org.id,
      name: 'Java Programming — Midterm',
      description: 'Midterm covering core Java language features.',
      instructions: 'Read each question carefully. You may not use external tools during this exam.',
      durationMinutes: 60,
      maxAttempts: 1,
      shuffleQuestions: true,
      shuffleOptions: true,
      negativeMarkingEnabled: true,
      negativeMarkingValue: 0.25,
      passingScore: 40,
      autoSubmit: true,
      status: 'SCHEDULED',
      createdBy: teacher.id,
      startAt: new Date(Date.now() - 24 * 3600 * 1000),
      endAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
  });

  await prisma.examSettings.upsert({
    where: { examId: exam.id },
    update: {},
    create: {
      examId: exam.id,
      cameraRequired: true,
      microphoneRequired: true,
      screenMonitoringRequired: true,
      identityVerificationRequired: true,
      aiProctoringEnabled: true,
      clipboardPolicy: 'BLOCK',
      fullScreenPolicy: 'REQUIRED',
      appSwitchPolicy: 'BLOCK',
      multipleFacePolicy: 'ALERT',
      phoneObjectDetection: true,
      allowOfflineMode: true,
      evidencePolicy: 'EVENT_ONLY',
      retentionDays: 90,
    },
  });

  // Link questions (drop stale links from previous seed runs first)
  await prisma.examQuestion.deleteMany({ where: { examId: exam.id } });
  await prisma.examQuestion.createMany({
    data: qRows.map((q, i) => ({ examId: exam.id, questionId: q.id, order: i + 1 })),
    skipDuplicates: true,
  });

  // Assign students + monitor
  for (const studentId of students) {
    await prisma.examAssignment.upsert({
      where: { examId_studentId: { examId: exam.id, studentId } },
      update: {},
      create: { examId: exam.id, studentId, assignedById: teacher.id },
    });
  }
  await prisma.examMonitorAssignment.upsert({
    where: { examId_monitorId: { examId: exam.id, monitorId: monitorProfile.id } },
    update: {},
    create: { examId: exam.id, monitorId: monitorProfile.id },
  });

  console.log('Seed complete.');
  console.log('Dev credentials (DEV ONLY):');
  console.log(`  Super admin:  superadmin@examguard.dev / ${DEV_PASSWORD}`);
  console.log(`  Org admin:    admin@northstar.edu / ${DEV_PASSWORD}`);
  console.log(`  Teacher:      teacher@northstar.edu / ${DEV_PASSWORD}`);
  console.log(`  Monitor:      monitor@northstar.edu / ${DEV_PASSWORD}`);
  console.log(`  Students:     student01..05@northstar.edu / ${DEV_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });