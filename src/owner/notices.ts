// What code, not the model, writes to the owner in Discord and issues, in the
// owner's language. Text the model reads stays in English beside the code that
// sends it.
export const notices = {
  sessionClosed: "이슈가 닫혀 이 세션을 종료합니다. 같은 알림 그룹의 다음 알림은 새 스레드와 새 이슈로 시작합니다.",
  replyToClosed: "이슈가 닫혀 종료된 세션이라 이 답글에는 응답하지 않습니다. 같은 알림 그룹의 다음 알림은 새 스레드로 시작합니다.",
  turnDropped: (attempts: number) => `이 알림의 조사가 ${attempts}번 실패해 중단했습니다. 오류는 agent 로그에 있습니다.`,
  // Also the issue's cause when the turn recorded none.
  turnStopped: "답을 내기 전에 중단했습니다. 이번 조사가 비용 또는 단계 한도에 닿았습니다.",
  noAnswer: "답 없이 끝났습니다. 다시 한 번 요청했지만 model이 텍스트를 내지 않았습니다.",
  monthlyCap: "이번 달 model 비용 한도에 닿았습니다. 알림은 다음 달(UTC)까지 조사하지 않고, Alertmanager를 통해 Discord에는 그대로 옵니다.",
  instructionsMissing: "운영 지침 clone이 없어 기본 지침만으로 조사합니다. 지침 git-sync sidecar의 로그를 확인하세요.",
  seedFailed: "SQLite 파일이 새로 만들어졌는데 metrics store에서 이번 달 model 비용을 읽지 못했습니다. 이번 달 한도는 0부터 셉니다.",
};

export const issueText = {
  symptom: "증상",
  cause: "원인",
  actions: "조치",
  noActions: "임시 조치 없음.",
  earlier: (ref: string) => `이 알림 그룹의 이전 이슈: ${ref}`,
  fallbackSymptom: (alertname: string, namespace: string | null, firing: number) =>
    `${alertname}, ${namespace === null ? "클러스터 전체" : `${namespace} 네임스페이스`}, 알림 ${firing}개 발생 중.`,
};
