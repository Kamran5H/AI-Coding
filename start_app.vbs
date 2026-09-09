' AI-Coding — Silent Web Studio Launcher
Option Explicit
Dim WshShell, fso, q, appDir, logPath, i
q = Chr(34)
appDir = "C:\Users\chkam\OneDrive\Desktop\AI-Coding"
logPath = appDir & "\ai_coding_launch.log"
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = appDir

Function ServerUp()
  Dim h
  ServerUp = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1500, 1500, 1500, 1500
  h.Open "GET", "http://localhost:8787/", False
  h.Send
  If Err.Number = 0 And (h.Status = 200 Or h.Status = 304) Then ServerUp = True
  On Error GoTo 0
End Function

If ServerUp() Then
  WshShell.Run "http://localhost:8787/", 1, False
  WScript.Quit
End If

WshShell.Run "cmd /c " & q & "node server.js > " & q & logPath & q & " 2>&1" & q, 0, False

For i = 1 To 20        ' up to 10s
  WScript.Sleep 500
  If ServerUp() Then Exit For
Next

WshShell.Run "http://localhost:8787/", 1, False
