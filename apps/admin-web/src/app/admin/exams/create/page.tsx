import { PageHeader } from '@examguard/ui';
import { ExamCreateForm } from '@/components/exam-create-form';

export default function CreateExamPage() {
  return (
    <>
      <PageHeader title="Create Exam" description="Configure the exam and its security policy." />
      <ExamCreateForm />
    </>
  );
}