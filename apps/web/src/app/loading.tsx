import { PageSkeleton } from "@/components/PageSkeleton";

/** 読み込み中（概要と、自前の `loading.tsx` を持たない画面の既定） */
export default function Loading() {
  return <PageSkeleton cards={3} />;
}
