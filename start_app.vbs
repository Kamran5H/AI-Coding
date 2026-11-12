' AI Coding - silent Windows launcher (no console window).
' Starts the local server from the folder this file is in and opens the app.
Option Explicit
Dim sh, fso, q, appDir, logPath, i
q = Chr(34)
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(appDir & "\server.js") Then
  MsgBox "server.js was not found next to this launcher:" & vbCrLf & appDir, vbExclamation, "AI Coding"
  WScript.Quit 1
End If
sh.CurrentDirectory = appDir
logPath = appDir & "\ai_coding_launch.log"

' First run (or the icon was deleted): put the shortcut on the desktop.
If Not fso.FileExists(sh.SpecialFolders("Desktop") & "\AI Coding.lnk") _
   And fso.FileExists(appDir & "\Install Desktop Shortcut.vbs") Then
  sh.Run "wscript //nologo " & q & appDir & "\Install Desktop Shortcut.vbs" & q & " /quiet", 0, False
End If

Function ServerUp()
  Dim h
  ServerUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1500, 1500, 1500, 1500
  h.Open "GET", "http://127.0.0.1:8787/api/state", False
  h.Send
  If Err.Number = 0 And h.Status = 200 Then ServerUp = True
  On Error GoTo 0
End Function

If ServerUp() Then
  sh.Run "http://localhost:8787/", 1, False
  WScript.Quit
End If

' First run: install the one dependency.
If Not fso.FolderExists(appDir & "\node_modules") Then
  sh.Run "cmd /c npm install > " & q & logPath & q & " 2>&1", 0, True
End If

sh.Run "cmd /c " & q & "node server.js >> " & q & logPath & q & " 2>&1" & q, 0, False

For i = 1 To 40        ' up to 20s
  WScript.Sleep 500
  If ServerUp() Then Exit For
Next

If ServerUp() Then
  sh.Run "http://localhost:8787/", 1, False
Else
  MsgBox "AI Coding did not start on port 8787." & vbCrLf & "Is Node.js installed? See the log: " & logPath, vbExclamation, "AI Coding"
End If
