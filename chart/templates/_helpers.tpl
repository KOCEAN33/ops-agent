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
    # The emptyDir is owned by root with fsGroup's group, and git refuses a
    # repository its user does not own.
    - --git-config=safe.directory:/git
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

{{/* A Litestream container on the data volume, holding the R2 credentials. */}}
{{- define "ops-agent.litestream" -}}
{{- $k := .root.Values.secret.keys -}}
{{- $secret := .root.Values.secret.name -}}
- name: {{ .name }}
  image: {{ .root.Values.litestream.image }}
  {{- if .sidecar }}
  restartPolicy: Always
  ports:
    - name: ls-metrics
      containerPort: {{ .root.Values.litestream.metricsPort }}
  {{- end }}
  args:
    {{- toYaml .args | nindent 4 }}
  env:
    {{- include "ops-agent.secretEnv" (dict "env" "R2_ENDPOINT" "secret" $secret "key" $k.r2Endpoint) | nindent 4 }}
    {{- include "ops-agent.secretEnv" (dict "env" "R2_BUCKET" "secret" $secret "key" $k.r2Bucket) | nindent 4 }}
    {{- include "ops-agent.secretEnv" (dict "env" "R2_ACCESS_KEY_ID" "secret" $secret "key" $k.r2AccessKeyId) | nindent 4 }}
    {{- include "ops-agent.secretEnv" (dict "env" "R2_SECRET_ACCESS_KEY" "secret" $secret "key" $k.r2SecretAccessKey) | nindent 4 }}
  securityContext:
    {{- include "ops-agent.containerSecurity" . | nindent 4 }}
  resources:
    {{- toYaml .root.Values.litestream.resources | nindent 4 }}
  volumeMounts:
    - name: data
      mountPath: /data
    - name: litestream
      mountPath: /etc/litestream
      readOnly: true
{{- end }}

{{- define "ops-agent.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}
