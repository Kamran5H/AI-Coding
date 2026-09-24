' AI-Coding — Resilient Silent Web Studio Launcher
' Automatically connects to backend live; auto-starts if not running.
Option Explicit
Dim WshShell, fso, q, appDir, logPath, i, candidates, cand
q = Chr(34)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(appDir & "\server.js") Then
    candidates = Array( _
        "C:\Users\chkam\OneDrive\Desktop\02_Projects & Development\AI-Coding", _
        "C:\Users\chkam\OneDrive\Desktop\AI-Coding", _
        "C:\Users\chkam\Desktop\02_Projects & Development\AI-Coding", _
        "C:\Users\chkam\Desktop\AI-Coding" _
    )
    For Each cand In candidates
        If fso.FileExists(cand & "\server.js") Then
            appDir = cand
            Exit For
        End If
    Next
End If

WshShell.CurrentDirectory = appDir
logPath = appDir & "\ai_coding_launch.log"

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

For i = 1 To 40        ' up to 20s
  WScript.Sleep 500
  If ServerUp() Then Exit For
Next

If ServerUp() Then
  WshShell.Run "http://localhost:8787/", 1, False
Else
  MsgBox "AI Coding server did not respond on port 8787." & vbCrLf & "Check log: " & logPath, vbExclamation, "AI Coding"
End If
