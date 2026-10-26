{{- define "ops-agent.fullname" -}}
{{- if contains .Chart.Name .Release.Name }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{ else }}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}

{{- define "ops-agent.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ops-agent.labels" -}}
{{ include "ops-agent.selector" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "ops-agent.image" -}}
{{- $repo := required "image.repository is required" .Values.image.repository -}}
{{- $tag := required "image.tag is required: pin a tag or a digest" .Values.image.tag -}}
{{- if hasPrefix "sha256:" $tag }}{{ printf "%s@%s" $repo $tag }}{{ else }}{{ printf "%s:%s" $repo $tag }}{{ end }}
{{- end }}

{{- define "ops-agent.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
{{- end }}

{{/* A git-sync sidecar for one repository. */}}
{{- define "ops-agent.gitSync" -}}
- name: git-sync-{{ .name }}
  image: {{ .root.Values.gitSync.image }}
  args:
    - --repo=https://github.com/{{ .repo }}
    - --ref=main
    - --root=/git
    - --link=current
    - --period={{ .root.Values.gitSync.period }}
    - --github-app-application-id={{ required "github.appId is required for a git-sync sidecar" .root.Values.github.appId }}
    - --github-app-installation-id={{ required "github.installationId is required for a git-sync sidecar" .root.Values.github.installationId }}
    - --github-app-private-key-file=/etc/github-app/key.pem
  env:
    - name: HOME
      value: /tmp
  securityContext:
    {{- include "ops-agent.containerSecurity" . | nindent 4 }}
  resources:
    {{- toYaml .root.Values.gitSyncResources | nindent 4 }}
  volumeMounts:
    - name: {{ .name }}
      mountPath: /git
    - name: github-app
      mountPath: /etc/github-app
      readOnly: true
    - name: tmp
      mountPath: /tmp
      subPath: git-sync-{{ .name }}
{{- end }}

{{- define "ops-agent.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}
