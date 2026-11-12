' AI Coding - creates or repairs the desktop shortcut.
'
' Double-click this file once (and again whenever you move this folder).
' It makes an "AI Coding" icon on your desktop that starts the app silently
' (no console window). Older AI Coding shortcuts on the desktop are re-pointed
' to this folder as well. Run with /quiet to skip the confirmation message.
Option Explicit

Dim shell, fso, appDir, launcher, icon, desktop, quiet, arg, fixed, name, f, lnk, target

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

quiet = False
For Each arg In WScript.Arguments
  If LCase(arg) = "/quiet" Then quiet = True
Next

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = appDir & "\start_app.vbs"
icon = appDir & "\icon.ico"

If Not fso.FileExists(launcher) Then
  If Not quiet Then MsgBox "start_app.vbs was not found in:" & vbCrLf & appDir, vbExclamation, "AI Coding"
  WScript.Quit 1
End If

Sub PointAt(path)
  Dim s
  Set s = shell.CreateShortcut(path)
  s.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\wscript.exe"
  s.Arguments = Chr(34) & launcher & Chr(34)
  s.WorkingDirectory = appDir
  s.WindowStyle = 1
  s.Description = "AI Coding - local coding agent"
  If fso.FileExists(icon) Then s.IconLocation = icon & ",0"
  s.Save
End Sub

desktop = shell.SpecialFolders("Desktop")
fixed = 0

' Re-point any older AI Coding shortcut already on the desktop.
If fso.FolderExists(desktop) Then
  For Each f In fso.GetFolder(desktop).Files
    If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
      name = LCase(fso.GetBaseName(f.Name))
      If name <> "ai coding" And (InStr(name, "ai coding") > 0 Or InStr(name, "ai-coding") > 0 Or InStr(name, "aicoding") > 0) Then
        Set lnk = shell.CreateShortcut(f.Path)
        target = LCase(lnk.Arguments & " " & lnk.TargetPath)
        If InStr(target, "start_app") > 0 Or InStr(target, "start-app") > 0 Or InStr(target, "server.js") > 0 Then
          PointAt f.Path
          fixed = fixed + 1
        End If
      End If
    End If
  Next
End If

PointAt desktop & "\AI Coding.lnk"

If Not quiet Then
  MsgBox "The AI Coding shortcut on your desktop is ready." & vbCrLf & vbCrLf & _
         "It starts the app silently and opens it in your browser." & vbCrLf & _
         "Older shortcuts repaired: " & fixed, vbInformation, "AI Coding"
End If
